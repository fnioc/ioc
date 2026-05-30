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
import type { DepSlot, Token } from "@fnioc/core";

import {
  AsyncDisposalRequiredError,
  CircularDependencyError,
  MissingMetadataError,
  MissingScopeError,
  NoSatisfiableSignatureError,
  UnregisteredTokenError,
} from "./errors.js";
import type {
  ClassRegistration,
  Ctor,
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
 * A node in the scope chain. Created from a `DiBuilder` (the root) or from a
 * parent scope (`.createScope`). Holds the instances it owns and any local
 * override registrations.
 *
 * The generic `Scopes` is the user's scope-name union, threaded so
 * `.createScope` only accepts declared names.
 */
export class Scope<Scopes extends string = string> implements ResolveScope {
  /** Local override registrations held at this scope (shadow ancestors). */
  private readonly localRegistrations = new Map<Token, Registration>();

  /** Instances this scope owns and caches, keyed by token. */
  private readonly instances = new Map<Token, unknown>();

  /** Owned instances in construction order — disposed in reverse. */
  private readonly ownedOrder: unknown[] = [];

  private disposed = false;

  public constructor(
    /** This scope's tag name. The root scope's name is its lifetime. */
    public readonly name: Scopes,
    /** The parent scope, or `undefined` for the root. */
    private readonly parent: Scope<Scopes> | undefined,
    /** The builder's base registration map (shared, walked last). */
    private readonly baseRegistrations: ReadonlyMap<Token, Registration>,
  ) {}

  /** Creates a parent-linked child scope with the given (declared) name. */
  public createScope(childName: Scopes): Scope<Scopes> {
    return new Scope<Scopes>(childName, this, this.baseRegistrations);
  }

  /**
   * Registers a scope-local override. Shadows any ancestor or base registration
   * for the same token, for this scope and its descendants only. The override
   * paths (`useFactory` / `useValue`) are also available here so a single scope
   * (e.g. a test scope) can swap an implementation without rebuilding the
   * builder.
   */
  public registerFactory<T>(
    token: Token,
    useFactory: (scope: ResolveScope) => T,
    tag?: Scopes,
  ): this {
    this.localRegistrations.set(token, {
      kind: "factory",
      useFactory: useFactory as (scope: ResolveScope) => unknown,
      tag,
    });
    return this;
  }

  /** Registers a scope-local `useValue` override (see `registerFactory`). */
  public registerValue<T>(token: Token, useValue: T): this {
    this.localRegistrations.set(token, { kind: "value", useValue });
    return this;
  }

  /**
   * Resolves a token to an instance, walking the parent chain for both the
   * registration and the owning scope. The public entry point starts a fresh
   * cycle-detection stack.
   */
  public resolve<T>(token: Token): T {
    return this.resolveWith<T>(token, []);
  }

  // ── Registration lookup ─────────────────────────────────────────────────────

  /**
   * Walks UP the chain (this scope's locals → ancestors' locals → base map),
   * returning the nearest registration for `token`. Child shadows parent.
   */
  private lookup(token: Token): Registration | undefined {
    // Aliasing `this` to walk the parent chain iteratively.
    let node: Scope<Scopes> | undefined = this;
    while (node !== undefined) {
      const local = node.localRegistrations.get(token);
      if (local !== undefined) return local;
      node = node.parent;
    }
    return this.baseRegistrations.get(token);
  }

  /**
   * Finds the nearest ancestor scope (inclusive of this one) whose name matches
   * `tag`, walking UP the chain. Returns `undefined` when none matches.
   */
  private findOwner(tag: string): Scope<Scopes> | undefined {
    // Aliasing `this` to walk the parent chain iteratively.
    let node: Scope<Scopes> | undefined = this;
    while (node !== undefined) {
      if (node.name === tag) return node;
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

    // Transient (no tag): never cached. Build relative to THIS scope and return
    // a fresh instance every time.
    if (registration.tag === undefined) {
      stack.push(token);
      try {
        return this.instantiate<T>(token, registration, this, stack);
      } finally {
        stack.pop();
      }
    }

    // Tagged: find the owning ancestor scope. No match ⇒ throw (never
    // auto-create — that is the captive-dependency detector).
    const owner = this.findOwner(registration.tag);
    if (owner === undefined) {
      throw new MissingScopeError(
        token,
        registration.tag,
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
    registration: ClassRegistration | Extract<Registration, { kind: "factory" }>,
    owningScope: Scope<Scopes>,
    stack: Token[],
  ): T {
    if (registration.kind === "factory") {
      // The factory resolves its own deps relative to the owning scope, but the
      // closure only sees a `resolve` that continues the active cycle stack.
      const scopeView: ResolveScope = {
        resolve: <U>(depToken: Token): U =>
          owningScope.resolveWith<U>(depToken, stack),
      };
      return registration.useFactory(scopeView) as T;
    }

    return owningScope.construct<T>(token, registration.ctor, stack);
  }

  /**
   * Constructs a class instance, resolving its constructor dependencies
   * relative to THIS scope (the owning scope). Performs greedy signature
   * selection over the ctor's DepRecord.
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

    const signature = this.selectSignature(token, ctor, record.signatures);
    const args = signature.map((dep) =>
      // All-token by selection — signatures containing a hole or a FactoryRef
      // are skipped this phase (Phase 2D.2 fills holes / injects factories).
      this.resolveWith<unknown>(dep as Token, stack),
    );
    return new ctor(...(args as never[])) as T;
  }

  /**
   * Greedy signature selection. Scans signatures longest → shortest and returns
   * the first DIRECTLY satisfiable one: every slot is a string token whose
   * registration is resolvable in this (the owning) scope's chain.
   *
   * - A `null` hole or a `FactoryRef` slot is NOT directly satisfiable this
   *   phase — signatures containing either are skipped (Phase 2D.2 fills holes
   *   and injects factories).
   * - Equal-arity ties break by registration order (the order signatures appear
   *   in the DepRecord), which `sort`'s stability preserves.
   * - None satisfiable ⇒ throw naming the unsatisfiable tokens.
   */
  private selectSignature(
    token: Token,
    ctor: Ctor,
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
      // Phase 2D.2: a hole (null) becomes a caller-supplied param and a
      // FactoryRef becomes an injected factory. Until then, a signature with
      // either kind of slot is not directly satisfiable — skip it. Only an
      // all-string-token signature is directly resolvable this phase.
      if (sig.some((dep) => typeof dep !== "string")) continue;

      let satisfiable = true;
      for (const dep of sig) {
        if (!this.isResolvable(dep as Token)) {
          satisfiable = false;
          unsatisfiable.add(dep as Token);
        }
      }
      if (satisfiable) return sig;
    }

    throw new NoSatisfiableSignatureError(token, ctor.name, [...unsatisfiable]);
  }

  /** True when `token` has a registration somewhere in this scope's chain. */
  private isResolvable(token: Token): boolean {
    return this.lookup(token) !== undefined;
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
