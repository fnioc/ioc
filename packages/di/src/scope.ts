// The scope frame + the resolution engine — the correctness core of the engine.
//
// Two complementary pieces:
//
//   `Scope` (frame) — a node in a parent-linked chain. Holds a name, a cache
//   of owned instances, a list for disposal ordering, and an optional parent
//   pointer. It does NOT hold registrations. There is no root frame: scopes are
//   uniform tags, and a `ServiceProvider` with no frame (the one `build()`
//   returns) resolves everything transiently until a scope is opened.
//
//   `ServiceProvider` — the public container surface. Implements `Resolver`
//   (resolve + resolveFactory) and `ScopeFactory` (createScope), plus native
//   `Disposable`/`AsyncDisposable`. Holds a sealed registration map (shared
//   across the tree) and an optional Scope frame.
//
// Resolution (§"The critical correctness rule"): on a cache miss the instance
// is constructed by resolving ITS constructor dependencies relative to the
// OWNING scope (the matched frame), never the scope that triggered the resolve.
// That is what keeps a long-lived service from silently capturing a shorter-lived
// one's cached instance — when no matching frame encloses the owner, the dep
// resolves transiently (a fresh instance) instead.

import type { DepSlot, FactoryRef, LiteralRef, ParsedToken, Token, TypeArgRef, Union } from "@fnioc/core";
import { isFactoryRef, isLiteralRef, isScopeRef, isTypeArgRef, isUnionSlot } from "./guards.js";
import { closeToken, isOpenToken, parseToken, substituteSignatures } from "./tokens.js";
import type { Func } from "@rhombus-toolkit/func";
import { assertNever } from "./assert.js";

import {
  AsyncDisposalRequiredError,
  AsyncResolutionRequiredError,
  CircularDependencyError,
  FactoryTargetError,
  MissingMetadataError,
  NoSatisfiableSignatureError,
  NoSatisfiableUnionError,
  OpenTokenResolutionError,
  UnregisteredTokenError,
} from "./errors.js";
import type {
  ClassRegistration,
  FactoryRegistration,
  OpenRegistration,
  Registration,
  Resolver,
  ScopeFactory,
} from "./types.js";

/** True when a value implements the native synchronous `Disposable`. */
function isDisposable(value: unknown): value is Disposable {
  return (
    value != null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { [Symbol.dispose]?: unknown })[Symbol.dispose] ===
      "function"
  );
}

/** True when a value implements the native `AsyncDisposable`. */
function isAsyncDisposable(value: unknown): value is AsyncDisposable {
  return (
    value != null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { [Symbol.asyncDispose]?: unknown })[
      Symbol.asyncDispose
    ] === "function"
  );
}

/** True when a value is thenable (a Promise or Promise-like). */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value != null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * The private carrier for an in-flight async resolution. Wrapping (instead of
 * passing a raw Promise) is what lets the resolver stay free of thenable
 * sniffing: a raw Promise flowing through resolution is always an honest VALUE
 * (a `Promise<X>` registration); a `Pending` is always the engine's own "not
 * settled yet" marker. Never escapes the public API.
 */
class Pending<T> {
  public constructor(
    public readonly promise: Promise<T>,
  ) {}
}

/** True when a spine result is the engine's in-flight carrier. */
function isPending<T>(value: T | Pending<T>): value is Pending<T> {
  return value instanceof Pending;
}

/**
 * Collapses a spine result to a Promise: the carried promise, or the value
 * resolved. Return type is `Promise<Awaited<T>>` (not `Promise<T>`) — honest
 * about promise auto-flattening, which is exactly what makes the `Promise<T>`
 * fallback deliver `T` on await. Both branches route through one `Promise.resolve`
 * so the `result.promise` branch (`Promise<T>`) typechecks against the awaited
 * return — a naive ternary does NOT (tsc: `T` is not assignable to `Awaited<T>`).
 * `Promise.resolve` on a native promise returns it unchanged — zero cost.
 */
function settle<T>(result: T | Pending<T>): Promise<Awaited<T>> {
  return Promise.resolve(isPending(result) ? result.promise : result);
}

/** The loud error for a raw `TypeArgRef` slot reaching resolution. */
function rawTypeArgError(slot: TypeArgRef): TypeError {
  return new TypeError(
    `Raw TypeArgRef slot { typeArg: ${slot.typeArg} } reached resolution — ` +
      `an open template's signature was used without substitution. Resolve a ` +
      `closed token so the engine can close the template, or substitute the ` +
      `signatures before hand-feeding them.`,
  );
}

/**
 * The string-token members of a `Union` (recursing into nested unions), used to
 * name what a fully-unsatisfiable union slot needs registered. Non-token members
 * (FactoryRef / ScopeRef / LiteralRef) contribute no token.
 */
function* unionTokenMembers(slot: Union): Generator<Token> {
  for (const member of slot.union) {
    if (typeof member === "string") {
      yield member;
    } else if (isUnionSlot(member as DepSlot)) {
      yield* unionTokenMembers(member as Union);
    }
  }
}

/**
 * A scope frame — a node in the parent-linked chain. Holds this scope's name,
 * its instance cache, an ordered list for disposal, and an optional parent.
 * It does NOT hold registrations (those live sealed on the ServiceProvider).
 *
 * A `ServiceProvider` with "no frame" resolves everything transiently — a
 * tagged registration whose frame is not open resolves to a fresh instance,
 * exactly like an untagged (transient) one. Frames are opened with
 * `createScope(name)`, never auto-created.
 */
export class Scope {
  /** Instances this scope owns and caches, keyed by token. */
  readonly cache: Map<Token, unknown> = new Map();

  /** Owned instances in construction order — disposed in reverse. */
  readonly owned: unknown[] = [];

  public constructor(
    /** This scope's name — must match the registration's lifetime tag. */
    public readonly name: string,
    /** The parent scope, or omitted for the topmost frame. */
    public readonly parent?: Scope,
  ) {}
}

/**
 * The public container surface. Implements `Resolver` (resolve + resolveFactory)
 * and `ScopeFactory` (createScope), plus native `Disposable`/`AsyncDisposable`.
 *
 * `S` is the user-declared scope-name union. The provider `ServiceManifest.build()`
 * returns is FRAMELESS — there is no root scope. With no frame open, every
 * resolution is transient; opening a scope with `createScope(name)` is what
 * lets a registration tagged with that name cache. "singleton" is not special —
 * it is just a tag you typically open once at the top via
 * `createScope("singleton")`.
 */
export class ServiceProvider<S extends string = string>
  implements Resolver, ScopeFactory<S>, Disposable, AsyncDisposable
{
  #disposed = false;

  /**
   * The scope frame for this provider. `undefined` means this provider has no
   * open scope — the frameless provider `build()` returns, where every
   * resolution is transient until a scope is opened with `createScope`.
   */
  readonly #frame: Scope | undefined;

  /** The sealed registration map (shared across all providers in the tree). */
  readonly #registrations: ReadonlyMap<Token, Registration[]>;

  /** The sealed OPEN-registration table (shared across the tree), keyed by base. */
  readonly #openRegistrations: ReadonlyMap<Token, readonly OpenRegistration[]>;

  /**
   * The memo of registrations synthesized from open matches, keyed by closed
   * token. Deliberately MUTABLE and shared across ALL providers of one tree
   * (`build()` creates it once and every `createScope` passes the same Map),
   * so a closing resolved in one frame reuses the identical Registration
   * object everywhere. The sealed maps are never touched.
   */
  readonly #closedMemo: Map<Token, Registration>;

  public constructor(
    registrations: ReadonlyMap<Token, Registration[]>,
    openRegistrations: ReadonlyMap<Token, readonly OpenRegistration[]>,
    closedMemo: Map<Token, Registration>,
    /** This provider's scope frame, if any. */
    frame?: Scope,
  ) {
    this.#registrations = registrations;
    this.#openRegistrations = openRegistrations;
    this.#closedMemo = closedMemo;
    this.#frame = frame;
  }

  /**
   * The name of this provider's open scope frame. Throws if the provider is
   * frameless (no scope open — e.g. the provider straight from `build()`).
   */
  public get name(): S {
    if (this.#frame === undefined) {
      throw new TypeError("This ServiceProvider has no scope frame open.");
    }
    return this.#frame.name as S;
  }

  // ── ScopeFactory ─────────────────────────────────────────────────────────────

  /**
   * Creates a child `ServiceProvider` whose scope frame is a new `Scope` named
   * `name`, parented to this provider's frame (or a top-level frame if this
   * provider is unscoped).
   *
   * Default name `"scoped"` is accepted only when `"scoped"` ∈ S (the
   * conditional-rest-param type ensures this at the call site).
   */
  public createScope(
    ...args: "scoped" extends S ? [name?: S] : [name: S]
  ): ServiceProvider<S> {
    const name = (args[0] ?? "scoped") as string;
    const childFrame = new Scope(name, this.#frame);
    return new ServiceProvider<S>(
      this.#registrations,
      this.#openRegistrations,
      this.#closedMemo,
      childFrame,
    );
  }

  // ── Resolver ─────────────────────────────────────────────────────────────────

  /**
   * Resolves synchronously. Runs the spine in sync mode — async never enters
   * (the `Promise<T>` fallback is gated off), so a miss is the honest
   * `UnregisteredTokenError`. A cached in-flight async construction throws
   * `AsyncResolutionRequiredError` (the guard here is defensive; sync mode
   * provably never RETURNS a Pending — a cached one throws inside the spine).
   * The public entry point starts a fresh cycle-detection stack.
   */
  public resolve<T>(token: Token): T;
  public resolve(token: Token): unknown;
  public resolve<T>(token?: Token): T {
    if (token === undefined) {
      throw new TypeError(
        "resolve<T>() requires the @fnioc/transformer plugin (no token at " +
          'runtime). Without it, resolve with an explicit token: ' +
          'resolve<T>("my:token").',
      );
    }
    const result = this.#resolve<T>(token, this.#frame, [], false);
    if (isPending(result)) {
      throw new AsyncResolutionRequiredError(token);
    }
    return result;
  }

  /**
   * Resolves asynchronously. Same spine, async mode: a lookup miss may be
   * satisfied by an honest `Promise<T>` registration. Always returns a Promise;
   * the Pending carrier never escapes. (`async` keyword: resolution errors
   * surface as rejections, the natural channel for a Promise-returning API.)
   */
  public resolveAsync<T>(token: Token): Promise<T>;
  public resolveAsync(token: Token): Promise<unknown>;
  public async resolveAsync<T>(token?: Token): Promise<T> {
    if (token === undefined) {
      throw new TypeError(
        "resolveAsync<T>() requires the @fnioc/transformer plugin (no token " +
          'at runtime). Without it, resolve with an explicit token: ' +
          'resolveAsync<T>("my:token").',
      );
    }
    return settle(this.#resolve<T>(token, this.#frame, [], true)) as Promise<T>;
  }

  /**
   * Returns a FACTORY for `type` rather than an instance. When `params` is
   * absent or empty, returns a strict zero-arg `() => T` — every ctor slot must
   * resolve from the container (an unresolvable slot throws). When `params` is
   * present, it is the complete authored-order list of caller-supplied parameter
   * tokens; the returned factory has shape `(...params) => T`. The authored
   * `resolve<(a: A) => T>()` lowers to `resolveFactory("pkg:T", ["pkg:A"])`.
   */
  public resolveFactory(type: Token, params?: readonly Token[]): unknown {
    return this.#makeFactory({ type, params }, this.#frame);
  }

  // ── Registration lookup ─────────────────────────────────────────────────────

  /**
   * Returns the most-recent registration for `token` from the sealed map.
   * The sealed map is shared across all providers in the tree; local overrides
   * are not supported in the new model (scope-local registration is deleted).
   *
   * The single lookup funnel — instance resolution, factory injection, and
   * satisfiability all come through here. On an exact miss the open-generic
   * fallback chain runs: memo hit → parse as closed-generic → open-table match
   * → substitute → synthesize a `ClassRegistration` → memoize. Exact beats
   * open (this order IS the precedence rule). Never throws: a holey token
   * simply misses (so `#isResolvable` is false for it); the dedicated error is
   * raised by `#resolve`.
   */
  #lookup(token: Token): Registration | undefined {
    const list = this.#registrations.get(token);
    if (list !== undefined && list.length) {
      return list[list.length - 1];
    }

    const memoized = this.#closedMemo.get(token);
    if (memoized !== undefined) {
      return memoized;
    }

    // An open template is not resolvable — and letting it reach the open table
    // would "close" the template with its own holes. Miss, never throw.
    if (isOpenToken(token)) {
      return undefined;
    }

    const parsed = parseToken(token);
    if (parsed === undefined) {
      return undefined;
    }

    const match = ServiceProvider.#matchOpen(
      this.#openRegistrations.get(parsed.base),
      parsed,
    );
    if (match === undefined) {
      return undefined;
    }

    // Synthesize the closed registration: the open registration's ctor + scope
    // tag, with the closing's arg tokens substituted through the template
    // signatures carried on the open registration. A signature-less open
    // registration has no template to substitute (a zero-arg ctor closes to a
    // bare `new Ctor()`).
    const template = match.open.signatures;
    // Substituting the carried signatures for this closing can fail when a
    // mis-authored template references a hole the service token never binds
    // (e.g. `IX<$1,$3>` carrying a dep on `$2`) — `substituteSignatures` throws
    // `RangeError` then. #lookup must NEVER throw (so `#isResolvable` can probe
    // safely and greedy selection can fall back), so treat a substitution
    // failure as a plain miss: no synthesis, no memo entry.
    let signatures: readonly (readonly DepSlot[])[] | undefined;
    if (template !== undefined) {
      try {
        signatures = substituteSignatures(template, match.args);
      } catch (err) {
        if (err instanceof RangeError) {
          return undefined;
        }
        throw err;
      }
    }
    const registration: ClassRegistration = {
      kind: "class",
      ctor: match.open.ctor,
      scope: match.open.scope,
      signatures,
    };
    this.#closedMemo.set(token, registration);
    return registration;
  }

  /**
   * Matches a parsed closed token against `base`'s open registrations —
   * iterated from the END so the most-recent match wins, mirroring the exact
   * map's last-wins list semantics. A candidate matches when its arity equals
   * the closing's and its repeated holes bind equal arg tokens. Returns the
   * matched registration plus the substitution args INDEXED BY HOLE NUMBER
   * (`args[N-1]` closes `$N` — the template's holes need not be in order).
   */
  static #matchOpen(
    list: readonly OpenRegistration[] | undefined,
    parsed: ParsedToken,
  ): { open: OpenRegistration; args: readonly Token[] } | undefined {
    if (list === undefined) {
      return undefined;
    }
    for (let i = list.length - 1; i >= 0; i--) {
      const open = list[i]!;
      if (open.pattern.length !== parsed.args.length) {
        continue;
      }
      const args = ServiceProvider.#bindPattern(open.pattern, parsed.args);
      if (args !== undefined) {
        return { open, args };
      }
    }
    return undefined;
  }

  /**
   * Binds a template's hole pattern (each entry exactly `$N` — validated at
   * registration) to a closing's arg tokens. Returns the args indexed by hole
   * number, or `undefined` when a repeated hole binds two different tokens.
   */
  static #bindPattern(
    pattern: readonly Token[],
    args: readonly Token[],
  ): readonly Token[] | undefined {
    const bound: Token[] = [];
    for (let i = 0; i < pattern.length; i++) {
      const hole = Number(pattern[i]!.slice(1));
      const prior = bound[hole - 1];
      if (prior === undefined) {
        bound[hole - 1] = args[i]!;
      } else if (prior !== args[i]) {
        return undefined;
      }
    }
    return bound;
  }

  /**
   * Finds the nearest ancestor scope frame (inclusive) whose name matches
   * `scopeName`, walking UP the chain. Returns `undefined` when none matches.
   */
  static #findOwner(
    vantage: Scope | undefined,
    scopeName: string,
  ): Scope | undefined {
    let node = vantage;
    while (node !== undefined) {
      if (node.name === scopeName) {return node;}
      node = node.parent;
    }
    return undefined;
  }

  // ── Resolution ──────────────────────────────────────────────────────────────

  /**
   * The spine. Owns the WHERE of resolution: cycle detection, lookup, the
   * async fallback (the ONLY place async enters), scope ownership, caching,
   * and single-flight. Construction mechanics live in `#instantiate`; slot
   * dispatch lives in `#resolveSlot`, whose token arm is the spine's only
   * re-entry point. Returns `T | Pending<T>` — the union is private and is
   * collapsed by the two public methods.
   *
   * `vantage` is the scope frame the walk starts from. `stack` is the active
   * resolution path (for cycle detection); it is shared across the whole
   * `resolve()`/`resolveAsync()` call but never across separate calls. `async`
   * gates whether the `Promise<T>` fallback can satisfy a lookup miss.
   */
  #resolve<T>(
    token: Token,
    vantage: Scope | undefined,
    stack: Token[],
    async: boolean,
  ): T | Pending<T> {
    if (stack.includes(token)) {
      throw new CircularDependencyError([...stack, token]);
    }

    const registration = this.#lookup(token);
    if (!registration) {
      // ── The async fallback — the only mint-site of a Pending from a raw
      // promise. A missing T satisfied by its honest Promise<T> registration:
      // resolve THAT (an ordinary direct hit — its cache entry is what makes
      // overlapping resolveAsync calls share one construction) and carry it.
      // Typing the inner resolve as T matches runtime truth: settle hands back
      // a promise that fulfills with T (promise auto-flattening).
      if (async) {
        const promiseToken = closeToken("Promise", token);
        if (this.#lookup(promiseToken)) {
          return new Pending(
            settle(this.#resolve<T>(promiseToken, vantage, stack, async)),
          );
        }
      }
      // A holey token can never resolve — it is a template naming a FAMILY of
      // tokens. Distinguish that from a plain miss so the fix is actionable.
      if (isOpenToken(token)) {
        throw new OpenTokenResolutionError(token);
      }
      throw new UnregisteredTokenError(token);
    }

    // useValue: the instance already exists; ownership/caching is moot. A raw
    // Promise<X> registered as a value returns here as an ordinary value.
    if (registration.kind === "value") {
      return registration.useValue as T;
    }

    // THE CENTRAL PRINCIPLE, as an expression: a scope tag with no matching
    // OPEN frame yields no owner, and no owner means transient — fresh
    // instance, no cache, no error. Untagged registrations take the same path.
    // The construct-relative-to-owner rule still holds: a longer-lived service
    // resolving a shorter-lived dep whose frame is not an ancestor gets a fresh
    // transient, never a captured cached instance.
    const owner = registration.scope
      ? ServiceProvider.#findOwner(vantage, registration.scope)
      : undefined;

    if (owner?.cache.has(token)) {
      const hit = owner.cache.get(token) as T | Pending<T>;
      if (isPending(hit) && !async) {
        // A concurrent async construction is in flight; sync cannot wait.
        throw new AsyncResolutionRequiredError(token);
      }
      return hit;
    }

    stack.push(token);
    try {
      // Construct relative to the OWNER when one exists — the critical rule —
      // otherwise relative to the current vantage (the transient path).
      const instance = this.#instantiate<T>(
        token,
        registration,
        owner ?? vantage,
        stack,
        async,
      );
      if (owner) {
        // Single-flight: the entry (a Pending included) lands in the cache
        // synchronously, before anything settles — overlapping resolveAsync
        // calls share one construction. `owned` keeps the Pending itself so
        // disposal sees what was actually produced.
        owner.cache.set(token, instance);
        owner.owned.push(instance);
        if (isPending(instance)) {
          // Self-upgrade on settle. The rejection no-op keeps this bookkeeping
          // channel from raising an unhandled rejection — consumers hold the
          // same promise and see the failure on their own channel. A rejected
          // Pending stays cached: single-flight shares outcomes, failures too.
          instance.promise.then(
            (value) => {
              owner.cache.set(token, value);
            },
            () => {},
          );
        }
      }
      return instance;
    } finally {
      stack.pop();
    }
  }

  /**
   * Owns the HOW of construction: metadata precedence, the no-metadata escape
   * hatches, greedy (async-aware) signature selection, slot fill, and the
   * fast/slow build. Collapses the former `#construct` / `#invokeFactory`.
   * Never touches the cache or the stack — that is the spine's job.
   * `owningFrame` is the scope frame whose chain the dependencies are resolved
   * against — THE critical rule.
   */
  #instantiate<T>(
    token: Token,
    registration: ClassRegistration | FactoryRegistration,
    owningFrame: Scope | undefined,
    stack: Token[],
    async: boolean,
  ): T | Pending<T> {
    // Signatures ride solely on the registration record now — the global store
    // is retired. Both class and factory registrations carry them.
    const source =
      registration.kind === "class" ? registration.ctor : registration.factory;
    const signatures = registration.signatures;

    if (!signatures?.length) {
      if (registration.kind === "factory") {
        // The plugin-less escape hatch: the live provider view is the sole
        // argument.
        return registration.factory(
          this.#makeProviderView(owningFrame, stack),
        ) as T;
      }
      if (registration.ctor.length) {
        throw new MissingMetadataError(token, registration.ctor.name);
      }
      return new registration.ctor() as T;
    }

    const signature = this.#selectSignature(
      token,
      source.name,
      signatures,
      async,
    );
    const args = signature.map((slot) =>
      this.#resolveSlot<unknown>(slot, owningFrame, stack, async),
    );

    const build: Func<[readonly unknown[]], T> = (builtArgs) => {
      switch (registration.kind) {
        case "class": {
          return new registration.ctor(...(builtArgs as never[])) as T;
        }
        case "factory": {
          return registration.factory(...builtArgs) as T;
        }
        default: {
          return assertNever(registration);
        }
      }
    };

    // FAST path: no pending arg — build synchronously, identical to today.
    if (!args.some(isPending)) {
      return build(args);
    }

    // SLOW path: settle args SEQUENTIALLY (constructor/owned ordering is part
    // of the contract — never Promise.all), then build. Only a Pending is
    // awaited; a raw Promise arg is an honest value and passes through intact.
    return new Pending(
      (async () => {
        const settled: unknown[] = [];
        for (const arg of args) {
          settled.push(isPending(arg) ? await arg.promise : arg);
        }
        return build(settled);
      })(),
    );
  }

  /**
   * The resolution view injected for a `ScopeRef` parameter (`Resolver` or
   * `ScopeFactory` typed param). Produces a ServiceProvider-like view that
   * continues the active cycle `stack` and resolves relative to `owningFrame`.
   */
  #makeProviderView(owningFrame: Scope | undefined, stack: Token[]): Resolver & ScopeFactory<S> {
    const sp = this;
    return {
      resolve: <U>(depToken?: Token): U => {
        if (depToken === undefined) {
          throw new TypeError(
            "resolve<T>() requires the @fnioc/transformer plugin (no token at " +
              "runtime).",
          );
        }
        // Sync mode never yields a Pending — the spine throws on a cached one.
        return sp.#resolve<U>(depToken, owningFrame, stack, false) as U;
      },
      resolveAsync: async <U>(depToken?: Token): Promise<U> => {
        if (depToken === undefined) {
          throw new TypeError(
            "resolveAsync<T>() requires the @fnioc/transformer plugin (no " +
              "token at runtime).",
          );
        }
        return settle(sp.#resolve<U>(depToken, owningFrame, stack, true)) as Promise<U>;
      },
      resolveFactory: (depToken: Token, depParams?: readonly Token[]): unknown =>
        sp.#makeFactory({ type: depToken, params: depParams }, owningFrame),
      createScope: (...args: ["scoped"?] | [S]): ServiceProvider<S> => {
        const name = (args[0] ?? "scoped") as string;
        const childFrame = new Scope(name, owningFrame);
        return new ServiceProvider<S>(
          sp.#registrations,
          sp.#openRegistrations,
          sp.#closedMemo,
          childFrame,
        );
      },
    } as Resolver & ScopeFactory<S>;
  }

  /**
   * Builds the callable injected for a `FactoryRef` parameter.
   *
   * When `ref.params` is absent or empty, the factory is STRICT: every ctor slot
   * of the target must resolve from the container. An unresolvable slot throws at
   * build time (via `selectSignature`). The result is a zero-arg `() => T` that
   * respects the target's registered lifetime.
   *
   * When `ref.params` is present, it is the COMPLETE authored-order list of
   * caller-supplied parameter tokens. The caller-supplied set is pinned to those
   * tokens (by first-occurrence left-to-right matching against ctor slots). A
   * slot token that appears in `params` is caller-supplied even if it is also
   * registered (caller wins). A slot that is neither claimed by `params` nor
   * resolvable from the container → error. The factory shape is exactly
   * `(...params) => T`; a fresh instance is built on every call (bypassing the
   * instance cache — caller args differ per call so caching would be wrong).
   *
   * Lifetime semantics:
   *   - A ZERO-ARG (no-params) factory routes through the normal `resolve` path
   *     and RESPECTS the target's registered lifetime.
   *   - A PARAMETERIZED factory constructs a FRESH instance every call.
   *
   * The closure captures `owningFrame`. §5.4 holds at call time: the target's
   * deps resolve relative to the scope that owns the factory-holding instance.
   */
  #makeFactory(
    ref: FactoryRef,
    owningFrame: Scope | undefined,
  ): Func<unknown[], unknown> {
    const sp = this;
    const target = this.#lookup(ref.type);

    if (target === undefined) {
      throw new FactoryTargetError(ref.type, "unregistered");
    }

    // A value target has no construction step — the "factory" is a thunk that
    // returns the stored instance (its lifetime is moot: a value is itself).
    if (target.kind === "value") {
      return () => sp.#resolve<unknown>(ref.type, owningFrame, [], false);
    }

    const callerParams = ref.params !== undefined && ref.params.length
      ? ref.params
      : undefined;

    if (callerParams === undefined) {
      // Strict zero-arg mode: every slot must resolve. Route through the normal
      // resolve path so the registered lifetime is respected.
      return () => sp.#resolve<unknown>(ref.type, owningFrame, [], false);
    }

    // Parameterized mode: the target's signatures ride on its registration
    // record (a synthesized closed-generic target carries its substituted
    // signatures). Select the target signature and partition slots against the
    // caller-supplied params list.
    const signatures = target.signatures;
    const targetSignature =
      signatures === undefined || !signatures.length
        ? undefined
        : sp.#selectTargetSignature(signatures);

    // Build a fresh instance on every call, threading caller args into the
    // params-claimed slots and resolving the remainder from the container.
    // A fresh cycle stack per call — the factory runs outside the resolve that
    // created it.
    return (...callArgs: unknown[]) =>
      sp.#buildPartitioned(
        target,
        targetSignature as readonly DepSlot[] | undefined,
        callerParams,
        callArgs,
        owningFrame,
      );
  }

  /**
   * Builds a factory target with the params-driven caller-supplied partition.
   *
   * `callerParams` is the authored-order list of tokens whose values are
   * supplied by the caller (from the `FactoryRef.params` list). Each ctor slot
   * whose token appears in `callerParams` (first-occurrence left-to-right match)
   * takes the corresponding `callArgs` value; every other slot resolves from the
   * container. A slot that is neither claimed nor resolvable → error (the factory
   * cannot be built). A claimed slot that is also registered → caller wins.
   *
   * Always builds a fresh result — a parameterized factory bypasses the instance
   * cache. Runs on a fresh cycle stack since the factory is invoked outside the
   * original resolve.
   *
   * `signature` may be `undefined` when the target has no DepRecord (zero-arg
   * ctor or record-less factory) — in that case args is empty.
   */
  #buildPartitioned<T>(
    target: ClassRegistration | FactoryRegistration,
    signature: readonly DepSlot[] | undefined,
    callerParams: readonly Token[],
    callArgs: readonly unknown[],
    owningFrame: Scope | undefined,
  ): T {
    const stack: Token[] = [];
    const providerView = this.#makeProviderView(owningFrame, stack);

    if (signature === undefined || !signature.length) {
      // No metadata: zero-arg ctor or record-less factory. Build directly.
      return (
        target.kind === "class"
          ? new target.ctor()
          : target.factory(providerView)
      ) as T;
    }

    // Build the remaining callerParams pool — we consume each token once
    // (first-occurrence matching), tracking which positions in callArgs remain.
    // We iterate the signature left-to-right and match ctor-slot tokens against
    // the callerParams list in authored order.
    //
    // Strategy: for each slot that is a plain string token, check if it appears
    // in the remaining (unmatched) callerParams. The first match in callerParams
    // order consumes the corresponding callArgs entry.
    //
    // We pre-build a mutable copy of the callerParams remaining indices so we
    // consume each param entry at most once.
    const remainingParamIndices: number[] = callerParams.map((_, i) => i);

    const args = signature.map((slot) => {
      if (typeof slot === "string") {
        // String token slot: check if it is claimed by callerParams (caller
        // wins, even if the token is also registered).
        const matchIdx = remainingParamIndices.findIndex(
          (pi) => callerParams[pi] === slot,
        );
        if (matchIdx !== -1) {
          const paramIdx = remainingParamIndices[matchIdx]!;
          remainingParamIndices.splice(matchIdx, 1); // consume this param entry
          return callArgs[paramIdx];
        }

        // Not claimed by callerParams. Must resolve from the container.
        if (!this.#isResolvable(slot, false)) {
          throw new NoSatisfiableSignatureError(slot, slot, [slot]);
        }
        return this.#resolve<unknown>(slot, owningFrame, stack, false);
      }
      // Every non-token kind delegates to THE switch, sync mode.
      return this.#resolveSlot<unknown>(slot, owningFrame, stack, false);
    });

    return (
      target.kind === "class"
        ? new target.ctor(...(args as never[]))
        : target.factory(...args)
    ) as T;
  }

  /**
   * Greedy signature selection. Scans signatures longest → shortest and returns
   * the first SATISFIABLE one. A slot is satisfiable when it is:
   *
   *   - a `FactoryRef` — always satisfiable; injected as a callable;
   *   - a `ScopeRef` — always satisfiable; filled with the live provider view;
   *   - a `LiteralRef` — always satisfiable; injected as its value (Rule 2);
   *   - a `Union` — satisfiable iff at least one member is resolvable; or
   *   - a string token whose registration exists in the sealed map.
   *
   * An unregistered string token is not satisfiable — unless `async` and its
   * honest `Promise<T>` registration exists (the fallback the spine will take).
   * Equal-arity ties break by registration order. None satisfiable ⇒ throw
   * naming the unsatisfiable tokens.
   */
  #selectSignature(
    token: Token,
    targetName: string,
    signatures: readonly (readonly DepSlot[])[],
    async: boolean,
  ): readonly DepSlot[] {
    // Stable sort by descending length; index keeps equal-arity ties in
    // registration order.
    const ordered = signatures
      .map((sig, index) => ({ sig, index }))
      .sort((a, b) =>
        b.sig.length !== a.sig.length
          ? b.sig.length - a.sig.length
          : a.index - b.index,
      );

    const unsatisfiable = new Set<Token>();
    for (const { sig } of ordered) {
      let satisfiable = true;
      for (const slot of sig) {
        if (isFactoryRef(slot) || isScopeRef(slot) || isLiteralRef(slot)) {continue;}
        if (isTypeArgRef(slot)) {
          // A raw TypeArgRef is an unclosed template slot — never satisfiable
          // (only substitution turns it into a LiteralRef).
          satisfiable = false;
          continue;
        }
        if (isUnionSlot(slot)) {
          // A union slot is satisfiable iff at least one member is resolvable.
          // When none is, surface its string-token members so the error names
          // exactly what to register.
          if (!this.#isResolvableSlot(slot, async)) {
            satisfiable = false;
            for (const token of unionTokenMembers(slot)) {unsatisfiable.add(token);}
          }
          continue;
        }
        if (!this.#isResolvable(slot, async)) {
          satisfiable = false;
          if (typeof slot === "string") {unsatisfiable.add(slot);}
        }
      }
      if (satisfiable) {return sig;}
    }

    throw new NoSatisfiableSignatureError(token, targetName, [...unsatisfiable]);
  }

  /**
   * Greedy signature selection for a FACTORY TARGET. Unlike `selectSignature`,
   * there is no resolvability gate: a target's unregistered tokens are not
   * unsatisfiable — they are the factory's caller-supplied parameters. So the
   * choice is purely the longest signature, equal-arity ties broken by
   * registration order.
   */
  #selectTargetSignature(
    signatures: readonly (readonly DepSlot[])[],
  ): readonly DepSlot[] {
    return signatures
      .map((sig, index) => ({ sig, index }))
      .sort((a, b) =>
        b.sig.length !== a.sig.length
          ? b.sig.length - a.sig.length
          : a.index - b.index,
      )[0]!.sig;
  }

  /**
   * True when `slot` is a registered string token — or, in `async` mode,
   * satisfiable via the honest `Promise<T>` fallback the spine would take. A
   * `FactoryRef`, `ScopeRef`, or `Union` is not tested here — use
   * `isResolvableSlot` for a full slot check.
   */
  #isResolvable(slot: DepSlot, async: boolean): boolean {
    if (typeof slot !== "string") {
      return false;
    }
    if (this.#lookup(slot)) {
      return true;
    }
    return async && !!this.#lookup(closeToken("Promise", slot));
  }

  /**
   * True when a slot is resolvable in ANY form:
   *   - `FactoryRef` / `ScopeRef` / `LiteralRef` — always satisfiable (injected);
   *   - `Union` — satisfiable iff at least one member is resolvable (recursive);
   *   - string token — registered in the sealed map, or (async) via the
   *     `Promise<T>` fallback.
   */
  #isResolvableSlot(slot: DepSlot, async: boolean): boolean {
    if (isFactoryRef(slot) || isScopeRef(slot) || isLiteralRef(slot)) {return true;}
    if (isTypeArgRef(slot)) {return false;}
    if (isUnionSlot(slot)) {
      return slot.union.some((member) =>
        this.#isResolvableSlot(member as DepSlot, async),
      );
    }
    return this.#isResolvable(slot, async);
  }

  /**
   * First-resolvable union. ONE loop serves both modes. In sync mode a member
   * either returns or throws (a Pending is impossible — the sync spine throws
   * on a cached one), so the loop degenerates to today's exact skip/try/catch.
   * In async mode a pending member wins only by SETTLING: on rejection the
   * carried promise re-enters this same method on the REMAINING members —
   * per-member sequential await+catch, expressed as recursion instead of a
   * second loop. The deferred re-entry runs against a snapshot of the path (the
   * live stack has unwound by the time a rejection lands).
   */
  #resolveUnion<T>(
    slot: Union,
    owningFrame: Scope | undefined,
    stack: Token[],
    async: boolean,
    members: readonly DepSlot[] = slot.union as readonly DepSlot[],
  ): T | Pending<T> {
    for (let i = 0; i < members.length; i++) {
      const member = members[i]!;
      if (!this.#isResolvableSlot(member, async)) {
        continue;
      }
      try {
        const result = this.#resolveSlot<T>(member, owningFrame, stack, async);
        if (!isPending(result)) {
          return result;
        }
        const rest = members.slice(i + 1);
        const snapshot = [...stack];
        return new Pending(
          result.promise.catch(() =>
            settle(this.#resolveUnion<T>(slot, owningFrame, snapshot, true, rest)),
          ),
        );
      } catch {
        // Member resolvable in principle but failed to build (cycle, missing
        // nested dep, …) — fall through to the next candidate.
        continue;
      }
    }
    throw new NoSatisfiableUnionError(slot.union);
  }

  /**
   * THE slot dispatch — the single copy of the 6-way branch, shared by the
   * spine's arg fill, union member resolution, and `#buildPartitioned`. The
   * token arm is the only canonical recursion re-entry into `#resolve`.
   *
   * An if-chain over the guard predicates (not a classifier + switch): each
   * guard narrows the slot for its own arm at zero cast cost, and exhausting
   * every object-slot guard leaves a bare string `Token` for the final arm. The
   * order mirrors the former dispatch order exactly.
   */
  #resolveSlot<T>(
    slot: DepSlot,
    owningFrame: Scope | undefined,
    stack: Token[],
    async: boolean,
  ): T | Pending<T> {
    if (isScopeRef(slot)) {
      return this.#makeProviderView(owningFrame, stack) as T;
    }
    if (isFactoryRef(slot)) {
      return this.#makeFactory(slot, owningFrame) as T;
    }
    if (isUnionSlot(slot)) {
      return this.#resolveUnion<T>(slot, owningFrame, stack, async);
    }
    if (isLiteralRef(slot)) {
      return slot.value as T;
    }
    if (isTypeArgRef(slot)) {
      throw rawTypeArgError(slot);
    }
    return this.#resolve<T>(slot, owningFrame, stack, async);
  }

  // ── Disposal ────────────────────────────────────────────────────────────────

  /**
   * Closes this provider synchronously, disposing the instances its scope frame
   * owns in REVERSE construction order. Only native `Disposable` instances are
   * disposed. NO cascade to child scopes.
   *
   * Throws `AsyncDisposalRequiredError` if any owned instance is a Promise
   * (thenable) — a pending Promise cannot be disposed synchronously; the caller
   * must use `disposeAsync()`. Idempotent: a second call is a no-op.
   */
  public dispose(): void {
    if (this.#disposed) {return;}

    const owned = this.#frame?.owned ?? [];

    for (const instance of owned) {
      // A Pending (in-flight or settled — `owned` is never upgraded) and a raw
      // owned promise both demand disposeAsync. isThenable lives ONLY here in
      // disposal — the resolver proper has no thenable sniffing.
      if (isPending(instance) || isThenable(instance)) {
        throw new AsyncDisposalRequiredError();
      }
    }

    this.#disposed = true;
    for (let i = owned.length - 1; i >= 0; i--) {
      const instance = owned[i];
      if (isDisposable(instance)) {
        instance[Symbol.dispose]();
      }
    }
    this.#clear();
  }

  /**
   * Closes this provider asynchronously. Awaits each owned Promise-valued
   * instance first (so an async factory's result settles before teardown), then
   * disposes owned instances in REVERSE construction order — honoring both
   * `Symbol.asyncDispose` and `Symbol.dispose`. Idempotent.
   */
  public async disposeAsync(): Promise<void> {
    if (this.#disposed) {return;}
    this.#disposed = true;

    const owned = this.#frame?.owned ?? [];

    // Resolve any in-flight (Pending) or Promise-valued instances to their
    // settled values so the disposer sees the real object, not the wrapper.
    const settled: unknown[] = [];
    for (const instance of owned) {
      // Guard each owned settle: a REJECTED owned Pending/thenable produced
      // nothing to dispose, and must not abort teardown of its siblings
      // (#disposed is already set, so an unguarded throw would leak every other
      // owned Disposable).
      if (isPending(instance)) {
        try {
          settled.push(await instance.promise);
        } catch {
          /* build rejected; nothing to dispose */
        }
      } else if (isThenable(instance)) {
        try {
          settled.push(await instance);
        } catch {
          /* build rejected; nothing to dispose */
        }
      } else {
        settled.push(instance);
      }
    }

    for (let i = settled.length - 1; i >= 0; i--) {
      const instance = settled[i];
      if (isAsyncDisposable(instance)) {
        await instance[Symbol.asyncDispose]();
      } else if (isDisposable(instance)) {
        instance[Symbol.dispose]();
      }
    }
    this.#clear();
  }

  /** Drops owned references after disposal so they can be collected. */
  #clear(): void {
    if (this.#frame) {
      this.#frame.cache.clear();
      this.#frame.owned.length = 0;
    }
  }

  /** Native `using` support — delegates to `dispose()`. */
  public [Symbol.dispose](): void {
    this.dispose();
  }

  /** Native `await using` support — delegates to `disposeAsync()`. */
  public [Symbol.asyncDispose](): Promise<void> {
    return this.disposeAsync();
  }
}
