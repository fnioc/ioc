// Shared runtime types for the engine: the concrete-constructor shape, the
// registration kinds, and the resolver-facing provider contract.

import type { Token, Union } from "@fnioc/core";
import type { Ctor, Func } from "@rhombus-toolkit/func";

export type { Union };

export type { Ctor };

/**
 * A registration-level factory function. Its parameters are filled by the
 * engine at resolve time, the same way a class constructor's are: a factory
 * WITH a `defineDeps` record has each parameter resolved by its slot (token →
 * resolved instance, `ScopeRef` → the live provider, hole → caller-supplied); a
 * factory WITHOUT a record is the plugin-less escape hatch and is called with
 * the live provider as its single argument (`(sp) => …`).
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
 * The named lifetime tag for a registration. `"singleton"` and `"transient"`
 * are the built-in names; `U` is the user-declared scope-name union (defaults
 * to `"scoped"`). Transient is represented by the ABSENCE of a lifetime tag
 * (`undefined` on the registration), not by the string `"transient"`.
 */
export type Lifetime<U extends string = "scoped"> = "singleton" | "transient" | U;

/**
 * The minimal resolution surface — resolve tokens and get factories. Injected
 * into factory parameters typed `Resolver` (and for the plugin-less escape
 * hatch as the sole argument of a record-less factory).
 *
 * `resolve` has two published shapes (the tokenless authoring form
 * `resolve<T>()` is a PURE TYPING contributed by the `@fnioc/transformer`
 * augmentation, not part of di's published surface):
 *   - `resolve<T>(token)`   — explicit token, typed return.
 *   - `resolve(token)`      — explicit token, `unknown` return (dynamic).
 */
export interface Resolver {
  resolve<T>(token: Token): T;
  resolve(token: Token): unknown;
  /**
   * Returns a FACTORY for `type` rather than an instance. When `params` is
   * absent or empty, returns a strict zero-arg `() => T` — every ctor slot must
   * resolve from the container. When `params` is present, it is the complete
   * authored-order list of caller-supplied parameter tokens; the returned factory
   * has shape `(...params) => T`. The authored `resolve<(a: A) => T>()` lowers
   * to `resolveFactory("pkg:T", ["pkg:A"])`.
   */
  resolveFactory(type: Token, params?: readonly Token[]): unknown;
}

/**
 * The scope-creation surface. Injected into factory parameters typed
 * `ScopeFactory`, and implemented by `ServiceProvider`.
 */
export interface ScopeFactory<S extends string = string> {
  createScope(
    ...args: "scoped" extends S ? [name?: S] : [name: S]
  ): ServiceProvider<S>;
}

/**
 * @deprecated Use `Resolver` instead. Kept for backwards compatibility.
 *
 * The resolution surface a factory receives — either as an injected `ScopeRef`
 * parameter, or (plugin-less escape hatch) as the sole argument of a
 * record-less factory.
 */
export interface ResolveScope extends Resolver {
  createScope(name: string): ServiceProvider;
}

// Forward declaration for the ScopeFactory generic — the concrete class is
// declared in scope.ts. TypeScript resolves cross-file interface references at
// the module level, so this avoids a circular import while keeping the
// interface definition here.
import type { ServiceProvider } from "./scope.js";
export type { ServiceProvider };
