// The scope chain + the resolution engine — the correctness core of the engine.
//
// A Scope is a node in a parent-linked chain. It owns and caches the instances
// whose lifetime tag matches its name, may hold local override registrations
// that shadow ancestors, and disposes the instances it owns in reverse
// construction order when closed.
//
// Resolution (§"The critical correctness rule"): on a cache miss the instance
// is constructed by resolving ITS constructor dependencies relative to the
// OWNING scope (the matched ancestor), never the scope that triggered the
// resolve. That is what makes a long-lived service depending on a shorter-lived
// one fail loudly instead of silently capturing it.

import { getDeps } from "@fnioc/core";
import type { DepSlot, FactoryRef, ScopeRef, Token } from "@fnioc/core";
import type { Func } from "@rhombus-toolkit/func";

import type { AddBuilder } from "./builder.js";
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
  ResolveScope,
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
 * True when a `DepSlot` is a `ScopeRef` — a parameter to be filled with the live
 * resolution scope itself (emitted for a factory/ctor param typed
 * `ResolveScope`). Distinguished from a `FactoryRef` by the `scope === true`
 * marker rather than a `.factory` token.
 */
function isScopeRef(slot: DepSlot): slot is ScopeRef {
  return (
    slot !== null &&
    typeof slot === "object" &&
    (slot as { scope?: unknown }).scope === true
  );
}

/**
 * A node in the scope chain. Created from a `DiBuilder` (the root) or from a
 * parent scope (`.createScope`). Holds the instances it owns and any local
 * override registrations.
 *
 * The generic `Scopes` is the user's scope-name union, threaded so
 * `.createScope` only accepts declared names.
 */
export class Scope<Scopes extends string = string> implements ResolveScope {
  /**
   * Local override registrations held at this scope (shadow ancestors). Each
   * token maps to a LIST in registration order; the most-recent (last) entry
   * wins, mirroring the builder's service collection.
   */
  private readonly localRegistrations = new Map<Token, Registration[]>();

  /** Instances this scope owns and caches, keyed by token. */
  private readonly instances = new Map<Token, unknown>();

  /** Owned instances in construction order — disposed in reverse. */
  private readonly ownedOrder: unknown[] = [];

  private disposed = false;

  public constructor(
    /** This scope's name. The root scope's name is its lifetime. */
    public readonly name: Scopes,
    /** The builder's base registration map (shared, walked last). */
    private readonly baseRegistrations: ReadonlyMap<Token, Registration[]>,
    /** The parent scope, or omitted for the root. */
    private readonly parent?: Scope<Scopes>,
  ) {}

  /** Appends a registration to a token's list in the given map. */
  private static appendTo(
    map: Map<Token, Registration[]>,
    token: Token,
    registration: Registration,
  ): void {
    const existing = map.get(token);
    if (existing === undefined) {
      map.set(token, [registration]);
    } else {
      existing.push(registration);
    }
  }

  /**
   * Creates a parent-linked child scope with the given (declared) name. Scopes
   * MUST nest — this parent chain IS the lifetime hierarchy. The root is minted
   * by `DiBuilder.build()`; every other scope descends from one via this call.
   */
  public createScope(childName: Scopes): Scope<Scopes> {
    return new Scope<Scopes>(childName, this.baseRegistrations, this);
  }

  /**
   * Appends a scopeless `class`/`factory` LOCAL override and returns the
   * `.as(scope?)` continuation (mirrors `DiBuilder.appendScoped`). Local
   * overrides shadow any ancestor or base registration for the same token, for
   * this scope and its descendants only, most-recent-wins.
   */
  private appendScopedLocal(
    token: Token,
    base: ClassRegistration | FactoryRegistration,
  ): AddBuilder<Scopes> {
    Scope.appendTo(this.localRegistrations, token, base);
    const map = this.localRegistrations;
    return {
      as<S extends Scopes>(scope?: S): void {
        if (scope === undefined) return;
        Scope.appendTo(map, token, { ...base, scope });
      },
    };
  }

  /**
   * Registers a scope-local CLASS override — shadows ancestors for this scope
   * and its descendants. Returns the `.as(scope?)` continuation.
   */
  public add(token: Token, ctor: Ctor): AddBuilder<Scopes> {
    return this.appendScopedLocal(token, {
      kind: "class",
      ctor,
      scope: undefined,
    });
  }

  /**
   * Registers a scope-local FACTORY override. Parameter injection follows the
   * same metadata rule as a builder factory (record → inject; record-less →
   * called with the live scope). Returns the `.as(scope?)` continuation.
   */
  public addFactory(
    token: Token,
    factory: Func<[ResolveScope], unknown>,
  ): AddBuilder<Scopes> {
    return this.appendScopedLocal(token, {
      kind: "factory",
      factory: factory as Factory,
      scope: undefined,
    });
  }

  /** Registers a scope-local VALUE override — the instance itself, no lifetime. */
  public addValue(token: Token, value: unknown): this {
    Scope.appendTo(this.localRegistrations, token, {
      kind: "value",
      useValue: value,
    });
    return this;
  }

  /**
   * Resolves a token to an instance, walking the parent chain for both the
   * registration and the owning scope. The public entry point starts a fresh
   * cycle-detection stack.
   */
  public resolve<T>(): T;
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
    return this.resolveWith<T>(token, []);
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
    return this.makeFactory({ factory: token });
  }

  // ── Registration lookup ─────────────────────────────────────────────────────

  /**
   * Walks UP the chain (this scope's locals → ancestors' locals → base map),
   * returning the nearest registration for `token`. Child shadows parent, and
   * within any one scope's list the most-recent (last) registration wins — so a
   * later `.add()`/`.add(...)` override beats an earlier one without deletion.
   */
  private lookup(token: Token): Registration | undefined {
    // Aliasing `this` to walk the parent chain iteratively.
    let node: Scope<Scopes> | undefined = this;
    while (node !== undefined) {
      const local = node.localRegistrations.get(token);
      if (local !== undefined && local.length > 0) return local[local.length - 1];
      node = node.parent;
    }
    const base = this.baseRegistrations.get(token);
    return base !== undefined && base.length > 0
      ? base[base.length - 1]
      : undefined;
  }

  /**
   * Finds the nearest ancestor scope (inclusive of this one) whose name matches
   * `scope`, walking UP the chain. Returns `undefined` when none matches.
   */
  private findOwner(scope: string): Scope<Scopes> | undefined {
    // Aliasing `this` to walk the parent chain iteratively.
    let node: Scope<Scopes> | undefined = this;
    while (node !== undefined) {
      if (node.name === scope) return node;
      node = node.parent;
    }
    return undefined;
  }

  /** The chain of scope names from this scope up to the root, for diagnostics. */
  private chainNames(): string[] {
    const names: string[] = [];
    // Aliasing `this` to walk the parent chain iteratively.
    let node: Scope<Scopes> | undefined = this;
    while (node !== undefined) {
      names.push(node.name);
      node = node.parent;
    }
    return names;
  }

  // ── Resolution ──────────────────────────────────────────────────────────────

  /**
   * The internal resolver. `stack` is the active resolution path (for cycle
   * detection); it is shared across the whole `resolve()` call but never across
   * separate calls.
   */
  private resolveWith<T>(token: Token, stack: Token[]): T {
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

    // Transient (no scope): never cached. Build relative to THIS scope and
    // return a fresh instance every time.
    if (registration.scope === undefined) {
      stack.push(token);
      try {
        return this.instantiate<T>(token, registration, this, stack);
      } finally {
        stack.pop();
      }
    }

    // Scoped: find the owning ancestor scope. No match ⇒ throw (never
    // auto-create — that is the captive-dependency detector).
    const owner = this.findOwner(registration.scope);
    if (owner === undefined) {
      throw new MissingScopeError(
        token,
        registration.scope,
        this.chainNames(),
      );
    }

    // Cache hit on the owner ⇒ return the cached instance (or Promise).
    if (owner.instances.has(token)) {
      return owner.instances.get(token) as T;
    }

    // Cache miss ⇒ construct relative to the OWNER, cache on the owner.
    stack.push(token);
    try {
      const instance = owner.instantiate<T>(token, registration, owner, stack);
      owner.instances.set(token, instance);
      owner.ownedOrder.push(instance);
      return instance;
    } finally {
      stack.pop();
    }
  }

  /**
   * Builds an instance for `registration`. `owningScope` is the scope whose
   * chain the dependencies are resolved against — THE critical rule. For a
   * factory override that is the scope passed to the closure; for a class it is
   * the scope its ctor deps resolve relative to.
   */
  private instantiate<T>(
    token: Token,
    registration: ClassRegistration | FactoryRegistration,
    owningScope: Scope<Scopes>,
    stack: Token[],
  ): T {
    if (registration.kind === "factory") {
      return owningScope.invokeFactory<T>(token, registration.factory, stack);
    }

    return owningScope.construct<T>(token, registration.ctor, stack);
  }

  /**
   * The resolution view a factory receives — `resolve` (overloaded; a tokenless
   * authored `resolve<T>()` is lowered to a token before runtime),
   * `resolveFactory`, and `createScope`, all continuing the active cycle
   * `stack` and resolving relative to THIS (the owning) scope.
   */
  private makeScopeView(stack: Token[]): ResolveScope {
    const owner = this;
    const view = {
      resolve: <U>(depToken?: Token): U => {
        if (depToken === undefined) {
          throw new TypeError(
            "resolve<T>() requires the @fnioc/transformer plugin (no token at " +
              "runtime).",
          );
        }
        return owner.resolveWith<U>(depToken, stack);
      },
      resolveFactory: (depToken: Token): unknown =>
        owner.makeFactory({ factory: depToken }),
      createScope: (name: string): ResolveScope =>
        owner.createScope(name as Scopes),
    };
    return view as ResolveScope;
  }

  /**
   * Invokes a factory registration under the metadata-vs-scope rule:
   *   - factory WITH a `defineDeps` record → resolve each slot (token →
   *     resolved instance, `ScopeRef` → the live scope, `FactoryRef` → an
   *     injected callable) and call `factory(...args)`;
   *   - factory WITHOUT a record (the plugin-less escape hatch) → call
   *     `factory(scopeView)` with the live scope as its sole argument.
   * Deps resolve relative to `this` (the owning scope) — §5.4.
   */
  private invokeFactory<T>(token: Token, factory: Factory, stack: Token[]): T {
    const scopeView = this.makeScopeView(stack);
    const record = getDeps(factory);
    if (record === undefined || record.signatures.length === 0) {
      return factory(scopeView) as T;
    }

    const signature = this.selectSignature(
      token,
      factory.name,
      record.signatures,
    );
    const args = signature.map((slot) => {
      if (isScopeRef(slot)) return scopeView;
      if (isFactoryRef(slot)) return this.makeFactory(slot);
      // Selection guarantees every remaining slot is a resolvable token (a hole
      // would have made this signature unsatisfiable).
      return this.resolveWith<unknown>(slot as Token, stack);
    });
    return factory(...args) as T;
  }

  /**
   * Constructs a class instance on a DIRECT resolve, resolving its constructor
   * dependencies relative to THIS scope (the owning scope). Performs greedy
   * signature selection over the ctor's DepRecord, then fills each slot:
   *
   *   - a string token → resolved through this scope's chain (selection
   *     guarantees every string-token slot here is resolvable);
   *   - a `FactoryRef` → injected as a callable (see `makeFactory`);
   *   - a `ScopeRef` → the live scope.
   *
   * A hole never reaches here on a direct resolve: it is an unresolvable token,
   * so selection rejects any signature carrying one (falling to a shorter
   * optional-overload, or throwing). Holes are filled by the caller only when
   * the class is a factory target — see `buildPartitioned`.
   */
  private construct<T>(token: Token, ctor: Ctor, stack: Token[]): T {
    const record = getDeps(ctor);

    // No metadata: a zero-arg ctor is `new`ed directly; a ctor with parameters
    // and no record is a hard error with actionable guidance.
    if (record === undefined || record.signatures.length === 0) {
      if (ctor.length > 0) {
        throw new MissingMetadataError(token, ctor.name);
      }
      return new ctor() as T;
    }

    const signature = this.selectSignature(token, ctor.name, record.signatures);

    const args = signature.map((slot) => {
      if (isScopeRef(slot)) {
        // A `ResolveScope`-typed parameter: inject the live scope (this owner).
        return this.makeScopeView(stack);
      }
      if (isFactoryRef(slot)) {
        // A factory-injected parameter: a callable that builds `slot.factory`'s
        // target on demand, resolving the target's own deps relative to THIS
        // scope (the owner) so §5.4 still holds at call time.
        return this.makeFactory(slot);
      }
      // A string token — resolve it through this scope's chain. (Selection
      // guarantees no hole reaches here: a hole is unresolvable, so a signature
      // containing one is never chosen for a direct resolve.)
      return this.resolveWith<unknown>(slot as Token, stack);
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
   * exposes only the target's unregistered parameters, in their relative order
   * — no Ramda-style placeholders, no leaked constructor arity.
   *
   * Lifetime semantics:
   *   - A ZERO-ARG factory (the target ctor has no holes / unregistered params)
   *     routes the build through the normal `resolve` path, so it RESPECTS the
   *     target's registered lifetime: a singleton target yields the same
   *     instance on every call; a transient target yields a fresh one.
   *   - A PARAMETERIZED factory (the target has holes / unregistered params
   *     filled per call) constructs a FRESH instance on every call and BYPASSES
   *     the instance cache. Caller args differ per call, so caching would be
   *     wrong — two calls with different arguments must not collapse to one
   *     cached instance.
   *
   * The closure captures `this` as the owning scope. §5.4 holds at call time:
   * the target's deps resolve relative to the scope that owns the
   * factory-holding instance, exactly as a direct resolve would — so a factory
   * captured by a singleton that tries to build a request-scoped target still
   * throws `MissingScopeError` when invoked.
   */
  private makeFactory(ref: FactoryRef): Func<unknown[], unknown> {
    const owningScope = this;
    const target = this.lookup(ref.factory);

    if (target === undefined) {
      throw new FactoryTargetError(ref.factory, "unregistered");
    }

    // A value target has no construction step — the "factory" is a thunk that
    // returns the stored instance (its lifetime is moot: a value is itself).
    if (target.kind === "value") {
      return () => owningScope.resolveWith<unknown>(ref.factory, []);
    }

    // The dep-metadata target is the ctor (class) or the factory function. Both
    // partition the same way; only the final build step differs (new vs call).
    const depTarget = target.kind === "class" ? target.ctor : target.factory;
    const record = getDeps(depTarget);
    const targetSignature =
      record === undefined || record.signatures.length === 0
        ? undefined
        : owningScope.selectTargetSignature(record.signatures);

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
          !owningScope.isResolvable(slot),
      );

    if (!parameterized) {
      return () => owningScope.resolveWith<unknown>(ref.factory, []);
    }

    // Parameterized factory: build a fresh instance each call, partitioning the
    // target signature against the live registration map and threading caller
    // args into the holes / unregistered slots. A fresh cycle stack per call —
    // the factory runs outside the resolve that created it.
    return (...callArgs: unknown[]) =>
      owningScope.buildPartitioned(
        target,
        targetSignature as ReadonlyArray<DepSlot>,
        callArgs,
      );
  }

  /**
   * Builds a factory target, partitioning its already-selected signature
   * against the live registration map: a registered token is resolved; a
   * `ScopeRef` is the live scope; a `FactoryRef` is injected; an unregistered
   * token or a `hole` takes the next caller-supplied argument positionally. A
   * class target is `new`ed, a factory target is called. Always a fresh result
   * — a parameterized factory bypasses the instance cache (caller args differ
   * per call). Runs on a fresh cycle stack since the factory is invoked outside
   * the original resolve.
   */
  private buildPartitioned<T>(
    target: ClassRegistration | FactoryRegistration,
    signature: ReadonlyArray<DepSlot>,
    callerArgs: readonly unknown[],
  ): T {
    const stack: Token[] = [];
    let nextCallerArg = 0;
    const args = signature.map((slot) => {
      if (isScopeRef(slot)) return this.makeScopeView(stack);
      if (isFactoryRef(slot)) return this.makeFactory(slot);
      // An unregistered token (a hole is just one) is caller-supplied: take the
      // next arg. A registered token resolves through the chain.
      if (!this.isResolvable(slot)) {
        return callerArgs[nextCallerArg++];
      }
      return this.resolveWith<unknown>(slot as Token, stack);
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
   *   - a `FactoryRef` — always satisfiable; injected as a callable. The
   *     factory's target need not be resolvable for the slot to count (an
   *     unregistered target surfaces a `FactoryTargetError` when the factory is
   *     built / called, not here);
   *   - a `ScopeRef` — always satisfiable; filled with the live scope; or
   *   - a string token whose registration is resolvable in this (the owning)
   *     scope's chain.
   *
   * A `hole` (`null`) is NOT special — it is an unregistered token, so it is
   * unsatisfiable on a direct resolve. A class with an optional/defaulted param
   * carries a shorter "without that arg" overload (emitted by the transformer);
   * greedy selection falls to it when the longer one can't be satisfied, so the
   * default / `undefined` applies. A required unfilled param has no such shorter
   * overload and surfaces a `NoSatisfiableSignatureError` (build it via a
   * factory instead). A signature is satisfiable iff every string-token slot is
   * resolvable.
   *
   * - Equal-arity ties break by registration order (the order signatures appear
   *   in the DepRecord), which `sort`'s stability preserves.
   * - None satisfiable ⇒ throw naming the unsatisfiable tokens.
   */
  private selectSignature(
    token: Token,
    targetName: string,
    signatures: ReadonlyArray<ReadonlyArray<DepSlot>>,
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
        // A FactoryRef or ScopeRef is always satisfiable (injected). A hole
        // (`null`) is just an unregistered token — it falls through to the
        // resolvability check and blocks the signature, so a class with an
        // unfilled param can only be built via the factory form (its shorter
        // optional-overload, if any, is what makes a default/optional resolve).
        if (isFactoryRef(slot) || isScopeRef(slot)) continue;
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
   * registration order (`sort` stability). Always returns a signature (the
   * caller has already checked `signatures.length > 0`).
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
   * True when `slot` is a registered string token somewhere in this scope's
   * chain. A hole (`null`), `FactoryRef`, or `ScopeRef` is not a registered
   * token, so it is never "resolvable" in this sense.
   */
  private isResolvable(slot: DepSlot): boolean {
    return typeof slot === "string" && this.lookup(slot) !== undefined;
  }

  // ── Disposal ────────────────────────────────────────────────────────────────

  /**
   * Closes this scope synchronously, disposing the instances it owns in REVERSE
   * construction order. Only native `Disposable` instances are disposed.
   *
   * Throws `AsyncDisposalRequiredError` if any owned instance is a Promise
   * (thenable) — a pending Promise cannot be disposed synchronously; the caller
   * must use `disposeAsync()`. Idempotent: a second call is a no-op.
   */
  public dispose(): void {
    if (this.disposed) return;

    for (const instance of this.ownedOrder) {
      if (isThenable(instance)) {
        throw new AsyncDisposalRequiredError();
      }
    }

    this.disposed = true;
    for (let i = this.ownedOrder.length - 1; i >= 0; i--) {
      const instance = this.ownedOrder[i];
      if (isDisposable(instance)) {
        instance[Symbol.dispose]();
      }
    }
    this.clear();
  }

  /**
   * Closes this scope asynchronously. Awaits each owned Promise-valued instance
   * first (so an async factory's result settles before teardown), then disposes
   * owned instances in REVERSE construction order — honoring both
   * `Symbol.asyncDispose` and `Symbol.dispose`. Idempotent.
   */
  public async disposeAsync(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    // Resolve any Promise-valued instances to their settled values so the
    // disposer sees the real object, not the wrapper.
    const settled: unknown[] = [];
    for (const instance of this.ownedOrder) {
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
    this.instances.clear();
    this.ownedOrder.length = 0;
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
