// The scope frame + the resolution engine — the correctness core of the engine.
//
// Two complementary pieces:
//
//   `Scope` (frame) — a node in a parent-linked chain. Holds a name, a cache
//   of owned instances, a list for disposal ordering, and an optional parent
//   pointer. It does NOT hold registrations. The special "empty slot" (no frame)
//   on the root ServiceProvider means transient-only / unscoped resolution.
//
//   `ServiceProvider` — the public container surface. Implements `Resolver`
//   (resolve + resolveFactory) and `ScopeFactory` (createScope), plus native
//   `Disposable`/`AsyncDisposable`. Holds a sealed registration map (shared
//   across the tree) and an optional Scope frame.
//
// Resolution (§"The critical correctness rule"): on a cache miss the instance
// is constructed by resolving ITS constructor dependencies relative to the
// OWNING scope (the matched ancestor), never the scope that triggered the
// resolve. That is what makes a long-lived service depending on a shorter-lived
// one fail loudly instead of silently capturing it.

import { getDeps } from "@fnioc/core";
import type { AnyOf, DepSlot, FactoryRef, ScopeRef, Token } from "@fnioc/core";
import type { Func } from "@rhombus-toolkit/func";

import {
  AsyncDisposalRequiredError,
  CircularDependencyError,
  FactoryTargetError,
  MissingMetadataError,
  MissingScopeError,
  NoSatisfiableSignatureError,
  UnregisteredTokenError,
} from "./errors.js";
import type {
  ClassRegistration,
  Ctor,
  Factory,
  FactoryRegistration,
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
 * True when a `DepSlot` is a `FactoryRef` — a factory-injected parameter. A
 * slot is a string token, the `hole` sentinel, or this object form. The
 * non-null-object check naturally excludes the hole sentinel whatever its
 * underlying value (a symbol or `null`), so this stays robust to that changing.
 */
function isFactoryRef(slot: DepSlot): slot is FactoryRef {
  return (
    slot !== null &&
    typeof slot === "object" &&
    typeof (slot as { factory?: unknown }).factory === "string"
  );
}

/**
 * True when a `DepSlot` is a `ScopeRef` — a parameter to be filled with the
 * live resolution provider itself (emitted for a factory/ctor param typed
 * `Resolver`, `ScopeFactory`, or the legacy `ResolveScope`).
 */
function isScopeRef(slot: DepSlot): slot is ScopeRef {
  return (
    slot !== null &&
    typeof slot === "object" &&
    (slot as { scope?: unknown }).scope === true
  );
}

/**
 * True when a `DepSlot` is an `AnyOf` — an inline union of alternatives tried
 * in declaration order. The first member that resolves wins; exhausting all
 * members throws `UnregisteredTokenError`.
 */
function isAnyOf(slot: DepSlot): slot is AnyOf {
  return (
    slot !== null &&
    typeof slot === "object" &&
    Array.isArray((slot as { anyOf?: unknown }).anyOf)
  );
}

/**
 * A scope frame — a node in the parent-linked chain. Holds this scope's name,
 * its instance cache, an ordered list for disposal, and an optional parent.
 * It does NOT hold registrations (those live sealed on the ServiceProvider).
 *
 * The special "no frame" on the root ServiceProvider means transient-only /
 * unscoped resolution — attempting to resolve a scoped registration from the
 * root will throw MissingScopeError.
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
 * `S` is the user-declared scope-name union. The root (`DiBuilder.build()`)
 * has an EMPTY scope slot — it acts as the unscoped root that owns singletons
 * when the root name is "singleton", reached by the first `createScope("singleton")`.
 * Wait — actually the root SP from build() DOES have a scope frame (named after
 * the builder's rootName), exactly as before: `build()` creates a root SP
 * with `new Scope(rootName)` as its frame.
 */
export class ServiceProvider<S extends string = string>
  implements Resolver, ScopeFactory<S>, Disposable, AsyncDisposable
{
  private disposed = false;

  /**
   * The scope frame for this provider. `undefined` means this is the "unscoped"
   * root — a sentinel that exists only for transient-only trees (no build()
   * call sets this to undefined in normal usage; build() always sets a root name).
   */
  private readonly frame: Scope | undefined;

  public constructor(
    /** The sealed registration map (shared across all providers in the tree). */
    private readonly registrations: ReadonlyMap<Token, Registration[]>,
    /** This provider's scope frame, if any. */
    frame?: Scope,
  ) {
    this.frame = frame;
  }

  /**
   * The name of this provider's scope frame. Throws if the provider has no
   * frame (unscoped root). Kept for backwards-compatibility with tests that
   * inspect `root.name`.
   */
  public get name(): S {
    if (this.frame === undefined) {
      throw new TypeError("This ServiceProvider has no scope frame (unscoped root).");
    }
    return this.frame.name as S;
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
    const childFrame = new Scope(name, this.frame);
    return new ServiceProvider<S>(this.registrations, childFrame);
  }

  // ── Resolver ─────────────────────────────────────────────────────────────────

  /**
   * Resolves a token to an instance, walking the scope chain for the owning
   * frame. The public entry point starts a fresh cycle-detection stack.
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
    return this.resolveWith<T>(token, this.frame, []);
  }

  /**
   * Returns a FACTORY for `token` rather than an instance — the resolve-site
   * mirror of a `FactoryRef` ctor param. The authored `resolve<(a: A) => T>()`
   * lowers here. The returned callable exposes the target's UNREGISTERED /
   * caller-supplied parameters in order (PRD §7 "Partial / positional
   * factories"); a fully-resolvable target yields a zero-arg lazy factory that
   * respects the target's registered lifetime.
   */
  public resolveFactory(token: Token): unknown {
    return this.makeFactory({ factory: token }, this.frame);
  }

  // ── Registration lookup ─────────────────────────────────────────────────────

  /**
   * Returns the most-recent registration for `token` from the sealed map.
   * The sealed map is shared across all providers in the tree; local overrides
   * are not supported in the new model (scope-local registration is deleted).
   */
  private lookup(token: Token): Registration | undefined {
    const list = this.registrations.get(token);
    return list !== undefined && list.length > 0 ? list[list.length - 1] : undefined;
  }

  /**
   * Finds the nearest ancestor scope frame (inclusive) whose name matches
   * `scopeName`, walking UP the chain. Returns `undefined` when none matches.
   */
  private static findOwner(
    vantage: Scope | undefined,
    scopeName: string,
  ): Scope | undefined {
    let node = vantage;
    while (node !== undefined) {
      if (node.name === scopeName) return node;
      node = node.parent;
    }
    return undefined;
  }

  /** The chain of scope names from `vantage` up to the root, for diagnostics. */
  private static chainNames(vantage: Scope | undefined): string[] {
    const names: string[] = [];
    let node = vantage;
    while (node !== undefined) {
      names.push(node.name);
      node = node.parent;
    }
    return names;
  }

  // ── Resolution ──────────────────────────────────────────────────────────────

  /**
   * The internal resolver. `vantage` is the scope frame the walk starts from.
   * `stack` is the active resolution path (for cycle detection); it is shared
   * across the whole `resolve()` call but never across separate calls.
   */
  private resolveWith<T>(
    token: Token,
    vantage: Scope | undefined,
    stack: Token[],
  ): T {
    if (stack.includes(token)) {
      throw new CircularDependencyError([...stack, token]);
    }

    const registration = this.lookup(token);
    if (registration === undefined) {
      throw new UnregisteredTokenError(token);
    }

    // useValue: the instance already exists; ownership/caching is moot.
    if (registration.kind === "value") {
      return registration.useValue as T;
    }

    // Transient (no scope): never cached. Build relative to current vantage and
    // return a fresh instance every time.
    if (registration.scope === undefined) {
      stack.push(token);
      try {
        return this.instantiate<T>(token, registration, vantage, stack);
      } finally {
        stack.pop();
      }
    }

    // Scoped: find the owning ancestor scope. No match ⇒ throw (never
    // auto-create — that is the captive-dependency detector).
    const owner = ServiceProvider.findOwner(vantage, registration.scope);
    if (owner === undefined) {
      throw new MissingScopeError(
        token,
        registration.scope,
        ServiceProvider.chainNames(vantage),
      );
    }

    // Cache hit on the owner ⇒ return the cached instance (or Promise).
    if (owner.cache.has(token)) {
      return owner.cache.get(token) as T;
    }

    // Cache miss ⇒ construct relative to the OWNER, cache on the owner.
    stack.push(token);
    try {
      const instance = this.instantiate<T>(token, registration, owner, stack);
      owner.cache.set(token, instance);
      owner.owned.push(instance);
      return instance;
    } finally {
      stack.pop();
    }
  }

  /**
   * Builds an instance for `registration`. `owningFrame` is the scope frame
   * whose chain the dependencies are resolved against — THE critical rule.
   */
  private instantiate<T>(
    token: Token,
    registration: ClassRegistration | FactoryRegistration,
    owningFrame: Scope | undefined,
    stack: Token[],
  ): T {
    if (registration.kind === "factory") {
      return this.invokeFactory<T>(token, registration.factory, owningFrame, stack);
    }

    return this.construct<T>(token, registration.ctor, owningFrame, stack);
  }

  /**
   * The resolution view injected for a `ScopeRef` parameter (`Resolver` or
   * `ScopeFactory` typed param). Produces a ServiceProvider-like view that
   * continues the active cycle `stack` and resolves relative to `owningFrame`.
   */
  private makeProviderView(owningFrame: Scope | undefined, stack: Token[]): Resolver & ScopeFactory<S> {
    const sp = this;
    return {
      resolve: <U>(depToken?: Token): U => {
        if (depToken === undefined) {
          throw new TypeError(
            "resolve<T>() requires the @fnioc/transformer plugin (no token at " +
              "runtime).",
          );
        }
        return sp.resolveWith<U>(depToken, owningFrame, stack);
      },
      resolveFactory: (depToken: Token): unknown =>
        sp.makeFactory({ factory: depToken }, owningFrame),
      createScope: (...args: ["scoped"?] | [S]): ServiceProvider<S> => {
        const name = (args[0] ?? "scoped") as string;
        const childFrame = new Scope(name, owningFrame);
        return new ServiceProvider<S>(sp.registrations, childFrame);
      },
    } as Resolver & ScopeFactory<S>;
  }

  /**
   * Invokes a factory registration under the metadata-vs-scope rule:
   *   - factory WITH a `defineDeps` record → resolve each slot (token →
   *     resolved instance, `ScopeRef` → the live provider view, `FactoryRef` →
   *     an injected callable) and call `factory(...args)`;
   *   - factory WITHOUT a record (the plugin-less escape hatch) → call
   *     `factory(providerView)` with the live provider view as its sole argument.
   * Deps resolve relative to `owningFrame` (the owning scope) — §5.4.
   */
  private invokeFactory<T>(
    token: Token,
    factory: Factory,
    owningFrame: Scope | undefined,
    stack: Token[],
  ): T {
    const providerView = this.makeProviderView(owningFrame, stack);
    const record = getDeps(factory);
    if (record === undefined || record.signatures.length === 0) {
      return factory(providerView) as T;
    }

    const signature = this.selectSignature(
      token,
      factory.name,
      record.signatures,
      owningFrame,
    );
    const args = signature.map((slot) => {
      if (isScopeRef(slot)) return providerView;
      if (isFactoryRef(slot)) return this.makeFactory(slot, owningFrame);
      if (isAnyOf(slot)) return this.resolveAnyOf(slot, owningFrame, stack);
      // Selection guarantees every remaining slot is a resolvable token (a hole
      // would have made this signature unsatisfiable).
      return this.resolveWith<unknown>(slot as Token, owningFrame, stack);
    });
    return factory(...args) as T;
  }

  /**
   * Constructs a class instance, resolving its constructor dependencies
   * relative to `owningFrame`. Performs greedy signature selection over the
   * ctor's DepRecord, then fills each slot:
   *
   *   - a string token → resolved through the owning frame's chain (selection
   *     guarantees every string-token slot here is resolvable);
   *   - a `FactoryRef` → injected as a callable (see `makeFactory`);
   *   - a `ScopeRef` → the live provider view.
   */
  private construct<T>(
    token: Token,
    ctor: Ctor,
    owningFrame: Scope | undefined,
    stack: Token[],
  ): T {
    const record = getDeps(ctor);

    // No metadata: a zero-arg ctor is `new`ed directly; a ctor with parameters
    // and no record is a hard error with actionable guidance.
    if (record === undefined || record.signatures.length === 0) {
      if (ctor.length > 0) {
        throw new MissingMetadataError(token, ctor.name);
      }
      return new ctor() as T;
    }

    const signature = this.selectSignature(token, ctor.name, record.signatures, owningFrame);

    const providerView = this.makeProviderView(owningFrame, stack);
    const args = signature.map((slot) => {
      if (isScopeRef(slot)) {
        // A `Resolver`/`ScopeFactory`/`ResolveScope`-typed parameter: inject the
        // live provider view (frame-bound to the owning scope).
        return providerView;
      }
      if (isFactoryRef(slot)) {
        // A factory-injected parameter: a callable that builds `slot.factory`'s
        // target on demand, resolving the target's own deps relative to the
        // owning frame so §5.4 still holds at call time.
        return this.makeFactory(slot, owningFrame);
      }
      if (isAnyOf(slot)) {
        // An inline-union parameter: try each member in declaration order; first
        // that resolves wins.
        return this.resolveAnyOf(slot, owningFrame, stack);
      }
      // A string token — resolve it through the owning frame's chain. (Selection
      // guarantees no hole reaches here: a hole is unresolvable, so a signature
      // containing one is never chosen for a direct resolve.)
      return this.resolveWith<unknown>(slot as Token, owningFrame, stack);
    });

    return new ctor(...(args as never[])) as T;
  }

  /**
   * Builds the callable injected for a `FactoryRef` parameter.
   *
   * The target ctor's signature is partitioned at CALL time against the live
   * registration map: each slot that is a registered token is resolved; each
   * slot that is an unregistered token or a `hole` takes the next
   * caller-supplied argument, positionally. The injected callable therefore
   * exposes only the target's unregistered parameters, in their relative order.
   *
   * Lifetime semantics:
   *   - A ZERO-ARG factory routes through the normal `resolve` path, so it
   *     RESPECTS the target's registered lifetime.
   *   - A PARAMETERIZED factory constructs a FRESH instance on every call and
   *     BYPASSES the instance cache. Caller args differ per call, so caching
   *     would be wrong.
   *
   * The closure captures `owningFrame`. §5.4 holds at call time: the target's
   * deps resolve relative to the scope that owns the factory-holding instance.
   */
  private makeFactory(
    ref: FactoryRef,
    owningFrame: Scope | undefined,
  ): Func<unknown[], unknown> {
    const sp = this;
    const target = this.lookup(ref.factory);

    if (target === undefined) {
      throw new FactoryTargetError(ref.factory, "unregistered");
    }

    // A value target has no construction step — the "factory" is a thunk that
    // returns the stored instance (its lifetime is moot: a value is itself).
    if (target.kind === "value") {
      return () => sp.resolveWith<unknown>(ref.factory, owningFrame, []);
    }

    // The dep-metadata target is the ctor (class) or the factory function. Both
    // partition the same way; only the final build step differs (new vs call).
    const depTarget = target.kind === "class" ? target.ctor : target.factory;
    const record = getDeps(depTarget);
    const targetSignature =
      record === undefined || record.signatures.length === 0
        ? undefined
        : sp.selectTargetSignature(record.signatures);

    // A target slot is caller-supplied when it is a hole or a string token NOT
    // in the live registration map. A nested FactoryRef / ScopeRef is itself
    // injected, never caller-supplied. If the target has any caller-supplied
    // slot the factory is parameterized; otherwise it is a bare zero-arg factory.
    const parameterized =
      targetSignature !== undefined &&
      targetSignature.some(
        (slot) =>
          !isFactoryRef(slot) &&
          !isScopeRef(slot) &&
          !sp.isResolvable(slot),
      );

    if (!parameterized) {
      return () => sp.resolveWith<unknown>(ref.factory, owningFrame, []);
    }

    // Parameterized factory: build a fresh instance each call, partitioning the
    // target signature against the live registration map and threading caller
    // args into the holes / unregistered slots. A fresh cycle stack per call —
    // the factory runs outside the resolve that created it.
    return (...callArgs: unknown[]) =>
      sp.buildPartitioned(
        target,
        targetSignature as ReadonlyArray<DepSlot>,
        callArgs,
        owningFrame,
      );
  }

  /**
   * Builds a factory target, partitioning its already-selected signature
   * against the live registration map: a registered token is resolved; a
   * `ScopeRef` is the live provider view; a `FactoryRef` is injected; an
   * unregistered token or a `hole` takes the next caller-supplied argument
   * positionally. A class target is `new`ed, a factory target is called.
   * Always a fresh result — a parameterized factory bypasses the instance cache.
   * Runs on a fresh cycle stack since the factory is invoked outside the
   * original resolve.
   */
  private buildPartitioned<T>(
    target: ClassRegistration | FactoryRegistration,
    signature: ReadonlyArray<DepSlot>,
    callerArgs: readonly unknown[],
    owningFrame: Scope | undefined,
  ): T {
    const stack: Token[] = [];
    const providerView = this.makeProviderView(owningFrame, stack);
    let nextCallerArg = 0;
    const args = signature.map((slot) => {
      if (isScopeRef(slot)) return providerView;
      if (isFactoryRef(slot)) return this.makeFactory(slot, owningFrame);
      if (isAnyOf(slot)) {
        if (this.isResolvable(slot)) {
          return this.resolveAnyOf(slot, owningFrame, stack);
        }
        // No member is resolvable — treat as caller-supplied.
        return callerArgs[nextCallerArg++];
      }
      // An unregistered token (a hole is just one) is caller-supplied: take the
      // next arg. A registered token resolves through the chain.
      if (!this.isResolvable(slot)) {
        return callerArgs[nextCallerArg++];
      }
      return this.resolveWith<unknown>(slot as Token, owningFrame, stack);
    });
    return (
      target.kind === "class"
        ? new target.ctor(...(args as never[]))
        : target.factory(...args)
    ) as T;
  }

  /**
   * Resolves an `AnyOf` slot by trying each member in declaration order. The
   * first member that resolves wins. Exhausting all members throws
   * `UnregisteredTokenError` on a joined description of the tried tokens.
   *
   * Members that are not `isResolvable` (holes, unregistered tokens) are skipped
   * immediately. Members that throw `MissingScopeError` (captive misregistration)
   * are caught and treated as "not resolved" — the next member is tried. This
   * means a `ScopeRef`-above-vantage member gracefully falls through to the next
   * candidate, rather than propagating the captive error.
   */
  private resolveAnyOf<T>(
    slot: AnyOf,
    owningFrame: Scope | undefined,
    stack: Token[],
  ): T {
    for (const member of slot.anyOf) {
      if (!this.isResolvable(member)) continue;
      try {
        return this.resolveSlot<T>(member, owningFrame, stack);
      } catch {
        // Member failed (UnregisteredTokenError, MissingScopeError, etc.) — try next.
        continue;
      }
    }
    // All members exhausted — unresolved.
    const tried = slot.anyOf
      .filter((m): m is Token => typeof m === "string")
      .join(" | ");
    throw new UnregisteredTokenError(tried || "<AnyOf>");
  }

  /**
   * Dispatch a single `DepSlot` to its resolution path. Factors out the
   * per-slot dispatch used inside `resolveAnyOf` (and could be shared with
   * `construct` / `invokeFactory`).
   */
  private resolveSlot<T>(
    slot: DepSlot,
    owningFrame: Scope | undefined,
    stack: Token[],
  ): T {
    if (isScopeRef(slot)) return this.makeProviderView(owningFrame, stack) as unknown as T;
    if (isFactoryRef(slot)) return this.makeFactory(slot, owningFrame) as unknown as T;
    if (isAnyOf(slot)) return this.resolveAnyOf<T>(slot, owningFrame, stack);
    // Must be a string token at this point.
    return this.resolveWith<T>(slot as Token, owningFrame, stack);
  }

  /**
   * Greedy signature selection. Scans signatures longest → shortest and returns
   * the first SATISFIABLE one. A slot is satisfiable when it is:
   *
   *   - a `FactoryRef` — always satisfiable; injected as a callable;
   *   - a `ScopeRef` — always satisfiable; filled with the live provider view; or
   *   - a string token whose registration exists in the sealed map.
   *
   * A `hole` (`null`) is NOT satisfiable on a direct resolve. An unregistered
   * string token is also not satisfiable. Equal-arity ties break by registration
   * order. None satisfiable ⇒ throw naming the unsatisfiable tokens.
   */
  private selectSignature(
    token: Token,
    targetName: string,
    signatures: ReadonlyArray<ReadonlyArray<DepSlot>>,
    _owningFrame: Scope | undefined,
  ): ReadonlyArray<DepSlot> {
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
        if (isFactoryRef(slot) || isScopeRef(slot)) continue;
        if (!this.isResolvable(slot)) {
          satisfiable = false;
          if (typeof slot === "string") {
            unsatisfiable.add(slot);
          } else if (isAnyOf(slot)) {
            // Collect the string-token members for the error message.
            for (const member of slot.anyOf) {
              if (typeof member === "string") unsatisfiable.add(member);
            }
          }
        }
      }
      if (satisfiable) return sig;
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
  private selectTargetSignature(
    signatures: ReadonlyArray<ReadonlyArray<DepSlot>>,
  ): ReadonlyArray<DepSlot> {
    return signatures
      .map((sig, index) => ({ sig, index }))
      .sort((a, b) =>
        b.sig.length !== a.sig.length
          ? b.sig.length - a.sig.length
          : a.index - b.index,
      )[0]!.sig;
  }

  /**
   * True when `slot` can be auto-resolved by the engine (not caller-supplied).
   *   - A string token: registered in the sealed map.
   *   - An `AnyOf`: at least one member is resolvable (recursive).
   *   - A `ScopeRef`: always resolvable (filled with the live provider view).
   *   - A `FactoryRef`: resolvable when its target is registered.
   *   - A hole (`null`): never resolvable (always caller-supplied).
   */
  private isResolvable(slot: DepSlot): boolean {
    if (typeof slot === "string") return this.lookup(slot) !== undefined;
    if (isAnyOf(slot)) return slot.anyOf.some((member) => this.isResolvable(member));
    if (isScopeRef(slot)) return true;
    if (isFactoryRef(slot)) return this.lookup(slot.factory) !== undefined;
    return false; // hole (null) — caller-supplied
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
    if (this.disposed) return;

    const owned = this.frame?.owned ?? [];

    for (const instance of owned) {
      if (isThenable(instance)) {
        throw new AsyncDisposalRequiredError();
      }
    }

    this.disposed = true;
    for (let i = owned.length - 1; i >= 0; i--) {
      const instance = owned[i];
      if (isDisposable(instance)) {
        instance[Symbol.dispose]();
      }
    }
    this.clear();
  }

  /**
   * Closes this provider asynchronously. Awaits each owned Promise-valued
   * instance first (so an async factory's result settles before teardown), then
   * disposes owned instances in REVERSE construction order — honoring both
   * `Symbol.asyncDispose` and `Symbol.dispose`. Idempotent.
   */
  public async disposeAsync(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    const owned = this.frame?.owned ?? [];

    // Resolve any Promise-valued instances to their settled values so the
    // disposer sees the real object, not the wrapper.
    const settled: unknown[] = [];
    for (const instance of owned) {
      settled.push(isThenable(instance) ? await instance : instance);
    }

    for (let i = settled.length - 1; i >= 0; i--) {
      const instance = settled[i];
      if (isAsyncDisposable(instance)) {
        await instance[Symbol.asyncDispose]();
      } else if (isDisposable(instance)) {
        instance[Symbol.dispose]();
      }
    }
    this.clear();
  }

  /** Drops owned references after disposal so they can be collected. */
  private clear(): void {
    if (this.frame) {
      this.frame.cache.clear();
      this.frame.owned.length = 0;
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
