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

import { getDeps, isFactoryRef as coreIsFactoryRef, isScopeRef as coreIsScopeRef, isUnionSlot } from "@fnioc/core";
import type { DepSlot, FactoryRef, ScopeRef, Token, Union } from "@fnioc/core";
import type { Func } from "@rhombus-toolkit/func";

import {
  AsyncDisposalRequiredError,
  CircularDependencyError,
  FactoryTargetError,
  MissingMetadataError,
  MissingScopeError,
  NoSatisfiableSignatureError,
  NoSatisfiableUnionError,
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
 * True when a `DepSlot` is a `FactoryRef` — a factory-injected parameter.
 * Delegates to the core guard which checks the `.type` field (T0 rename).
 */
const isFactoryRef: (slot: DepSlot) => slot is FactoryRef = coreIsFactoryRef;

/**
 * True when a `DepSlot` is a `ScopeRef` — a parameter to be filled with the
 * live resolution provider itself (emitted for a factory/ctor param typed
 * `Resolver`, `ScopeFactory`, or the legacy `ResolveScope`).
 */
const isScopeRef: (slot: DepSlot) => slot is ScopeRef = coreIsScopeRef as (slot: DepSlot) => slot is ScopeRef;

/**
 * True when a `DepSlot` is a `Union` — a set of alternative slots tried in
 * declaration order.
 */
const isUnion: (slot: DepSlot) => slot is Union = isUnionSlot;

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
   * Returns a FACTORY for `type` rather than an instance. When `params` is
   * absent or empty, returns a strict zero-arg `() => T` — every ctor slot must
   * resolve from the container (an unresolvable slot throws). When `params` is
   * present, it is the complete authored-order list of caller-supplied parameter
   * tokens; the returned factory has shape `(...params) => T`. The authored
   * `resolve<(a: A) => T>()` lowers to `resolveFactory("pkg:T", ["pkg:A"])`.
   */
  public resolveFactory(type: Token, params?: readonly Token[]): unknown {
    return this.makeFactory({ type, params }, this.frame);
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
      resolveFactory: (depToken: Token, depParams?: readonly Token[]): unknown =>
        sp.makeFactory({ type: depToken, params: depParams }, owningFrame),
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
      if (isUnion(slot)) return this.resolveUnion(slot, owningFrame, stack);
      // Selection guarantees every remaining slot is a resolvable string token.
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
        // A factory-injected parameter: a callable that builds the target on demand,
        // resolving the target's own deps relative to the owning frame so §5.4
        // still holds at call time.
        return this.makeFactory(slot, owningFrame);
      }
      if (isUnion(slot)) {
        // A union slot: try members in declaration order, return first resolvable.
        return this.resolveUnion(slot, owningFrame, stack);
      }
      // A string token — resolve it through the owning frame's chain. Selection
      // guarantees every string-token slot here is resolvable.
      return this.resolveWith<unknown>(slot as Token, owningFrame, stack);
    });

    return new ctor(...(args as never[])) as T;
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
  private makeFactory(
    ref: FactoryRef,
    owningFrame: Scope | undefined,
  ): Func<unknown[], unknown> {
    const sp = this;
    const target = this.lookup(ref.type);

    if (target === undefined) {
      throw new FactoryTargetError(ref.type, "unregistered");
    }

    // A value target has no construction step — the "factory" is a thunk that
    // returns the stored instance (its lifetime is moot: a value is itself).
    if (target.kind === "value") {
      return () => sp.resolveWith<unknown>(ref.type, owningFrame, []);
    }

    const callerParams = ref.params !== undefined && ref.params.length > 0
      ? ref.params
      : undefined;

    if (callerParams === undefined) {
      // Strict zero-arg mode: every slot must resolve. Route through the normal
      // resolve path so the registered lifetime is respected.
      return () => sp.resolveWith<unknown>(ref.type, owningFrame, []);
    }

    // Parameterized mode: the dep-metadata target is the ctor (class) or the
    // factory function. Select the target signature and partition slots against
    // the caller-supplied params list.
    const depTarget = target.kind === "class" ? target.ctor : target.factory;
    const record = getDeps(depTarget);
    const targetSignature =
      record === undefined || record.signatures.length === 0
        ? undefined
        : sp.selectTargetSignature(record.signatures);

    // Build a fresh instance on every call, threading caller args into the
    // params-claimed slots and resolving the remainder from the container.
    // A fresh cycle stack per call — the factory runs outside the resolve that
    // created it.
    return (...callArgs: unknown[]) =>
      sp.buildPartitioned(
        target,
        targetSignature as ReadonlyArray<DepSlot> | undefined,
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
  private buildPartitioned<T>(
    target: ClassRegistration | FactoryRegistration,
    signature: ReadonlyArray<DepSlot> | undefined,
    callerParams: readonly Token[],
    callArgs: readonly unknown[],
    owningFrame: Scope | undefined,
  ): T {
    const stack: Token[] = [];
    const providerView = this.makeProviderView(owningFrame, stack);

    if (signature === undefined || signature.length === 0) {
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
      if (isScopeRef(slot)) return providerView;
      if (isFactoryRef(slot)) return this.makeFactory(slot, owningFrame);
      if (isUnion(slot)) return this.resolveUnion(slot, owningFrame, stack);

      // String token slot: check if it is claimed by callerParams (caller wins,
      // even if the token is also registered).
      const token = slot as Token;
      const matchIdx = remainingParamIndices.findIndex(
        (pi) => callerParams[pi] === token,
      );
      if (matchIdx !== -1) {
        const paramIdx = remainingParamIndices[matchIdx]!;
        remainingParamIndices.splice(matchIdx, 1); // consume this param entry
        return callArgs[paramIdx];
      }

      // Not claimed by callerParams. Must resolve from the container.
      if (!this.isResolvable(token)) {
        throw new NoSatisfiableSignatureError(
          token,
          token,
          [token],
        );
      }
      return this.resolveWith<unknown>(token, owningFrame, stack);
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
   *   - a `Union` — satisfiable iff at least one member is resolvable; or
   *   - a string token whose registration exists in the sealed map.
   *
   * An unregistered string token is not satisfiable. Equal-arity ties break by
   * registration order. None satisfiable ⇒ throw naming the unsatisfiable tokens.
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
        if (isUnion(slot)) {
          // A union slot is satisfiable iff at least one member is resolvable.
          if (!this.isResolvableSlot(slot)) {
            satisfiable = false;
          }
          continue;
        }
        if (!this.isResolvable(slot)) {
          satisfiable = false;
          if (typeof slot === "string") unsatisfiable.add(slot);
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
   * True when `slot` is a registered string token in the sealed map. A
   * `FactoryRef`, `ScopeRef`, or `Union` is not tested here — use
   * `isResolvableSlot` for a full slot check.
   */
  private isResolvable(slot: DepSlot): boolean {
    return typeof slot === "string" && this.lookup(slot) !== undefined;
  }

  /**
   * True when a slot is resolvable in ANY form:
   *   - `FactoryRef` / `ScopeRef` — always satisfiable (injected);
   *   - `Union` — satisfiable iff at least one member is resolvable (recursive);
   *   - string token — registered in the sealed map.
   */
  private isResolvableSlot(slot: DepSlot): boolean {
    if (isFactoryRef(slot) || isScopeRef(slot)) return true;
    if (isUnion(slot)) {
      return slot.union.some((member) => this.isResolvableSlot(member as DepSlot));
    }
    return this.isResolvable(slot);
  }

  /**
   * Resolves a `Union` slot: tries each member in declaration order and returns
   * the first resolvable one. If no member is resolvable, throws
   * `NoSatisfiableUnionError`.
   */
  private resolveUnion<T>(
    slot: Union,
    owningFrame: Scope | undefined,
    stack: Token[],
  ): T {
    for (const member of slot.union) {
      if (this.isResolvableSlot(member as DepSlot)) {
        return this.resolveSlot<T>(member as DepSlot, owningFrame, stack);
      }
    }
    throw new NoSatisfiableUnionError(slot.union);
  }

  /**
   * Resolves a single `DepSlot` to its value, dispatching on slot kind.
   * Used by `resolveUnion` to recurse into members.
   */
  private resolveSlot<T>(
    slot: DepSlot,
    owningFrame: Scope | undefined,
    stack: Token[],
  ): T {
    if (isScopeRef(slot)) return this.makeProviderView(owningFrame, stack) as T;
    if (isFactoryRef(slot)) return this.makeFactory(slot, owningFrame) as T;
    if (isUnion(slot)) return this.resolveUnion<T>(slot, owningFrame, stack);
    return this.resolveWith<T>(slot as Token, owningFrame, stack);
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
