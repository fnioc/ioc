// Shared runtime types for the engine: the concrete-constructor shape, the
// registration kinds, and the resolver-facing scope contract.

import type { Token } from "@fnioc/core";
import type { Ctor, Func } from "@rhombus-toolkit/func";

export type { Ctor };

/**
 * A registration-level factory function. Its parameters are filled by the
 * engine at resolve time, the same way a class constructor's are: a factory
 * WITH a `defineDeps` record has each parameter resolved by its slot (token →
 * resolved instance, `ScopeRef` → the live scope, hole → caller-supplied); a
 * factory WITHOUT a record is the plugin-less escape hatch and is called with
 * the live scope as its single argument (`(scope) => …`).
 *
 * May be async — it can return a `Promise<T>`. The container never awaits; the
 * Promise flows through the sync resolution channel as a value (§"Async as
 * values"). A consumer that depends on it declares `Promise<T>` and awaits.
 */
export type Factory = Func<any[], unknown>;

/** A class registration: a token bound to a concrete constructor. */
export interface ClassRegistration {
  readonly kind: "class";
  readonly ctor: Ctor;
  /**
   * The lifetime — the scope name that owns and caches the instance.
   * `undefined` means transient (never cached; a fresh instance per resolve).
   */
  readonly scope: string | undefined;
}

/** A factory-function registration — its params are injected like a ctor's. */
export interface FactoryRegistration {
  readonly kind: "factory";
  readonly factory: Factory;
  /**
   * The lifetime — the scope name that owns and caches the result. `undefined`
   * means transient (the factory runs on every resolve). Attached via `.as()`,
   * exactly like a class registration.
   */
  readonly scope: string | undefined;
}

/** A value registration — an already-built instance, no lifetime. */
export interface ValueRegistration {
  readonly kind: "value";
  readonly useValue: unknown;
}

/** Any registration the engine can resolve. */
export type Registration =
  | ClassRegistration
  | FactoryRegistration
  | ValueRegistration;

/**
 * The resolution surface a factory receives — either as an injected `ScopeRef`
 * parameter, or (plugin-less escape hatch) as the sole argument of a
 * record-less factory. A structural subset of `Scope`: resolve further tokens
 * and open child scopes.
 *
 * `resolve` has two published shapes (the tokenless authoring form
 * `resolve<T>()` is a PURE TYPING contributed by the `@fnioc/transformer`
 * augmentation, not part of di's published surface):
 *   - `resolve<T>(token)`   — explicit token, typed return.
 *   - `resolve(token)`      — explicit token, `unknown` return (dynamic).
 */
export interface ResolveScope {
  resolve<T>(token: Token): T;
  resolve(token: Token): unknown;
  /**
   * Returns a FACTORY for the token rather than an instance — the resolve-site
   * mirror of a `FactoryRef` ctor param. The authored `resolve<(a: A) => T>()`
   * (a function-typed type arg) lowers to this.
   */
  resolveFactory(token: Token): unknown;
  createScope(name: string): ResolveScope;
}
