// Shared runtime types for the engine: the concrete-constructor shape, the
// registration kinds, and the resolver-facing scope contract.

import type { Token } from "@fnioc/core";

/**
 * A concrete, instantiable constructor producing `I`.
 *
 * Deliberately plain `new (...) => I`, NOT `abstract new (...) => I`: the
 * container instantiates the concrete type, and an `abstract` class cannot be
 * `new`ed. Passing an abstract class to `.add()` is therefore a type error —
 * exactly the desired rejection.
 */
export type Ctor<I = unknown> = new (...args: never[]) => I;

/**
 * A factory override: a closure that builds the instance, given the scope it is
 * being resolved into (so the factory can `scope.resolve(...)` its own deps).
 *
 * May be async — it can return a `Promise<T>`. The container never awaits; the
 * Promise flows through the sync resolution channel as a value (§"Async as
 * values"). A consumer that depends on it declares `Promise<T>` and awaits.
 */
export type Factory<T = unknown> = (scope: ResolveScope) => T;

/** A class registration: a token bound to a concrete constructor. */
export interface ClassRegistration {
  readonly kind: "class";
  readonly ctor: Ctor;
  /**
   * The lifetime tag — the scope name that owns and caches the instance.
   * `undefined` means transient (never cached; a fresh instance per resolve).
   */
  readonly tag: string | undefined;
}

/** A `useFactory` override registration. */
export interface FactoryRegistration {
  readonly kind: "factory";
  readonly useFactory: Factory;
  readonly tag: string | undefined;
}

/** A `useValue` override registration — an already-built instance. */
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
 * The resolution surface a factory closure receives. A structural subset of
 * `Scope` exposing only what an override needs — resolving further tokens.
 */
export interface ResolveScope {
  resolve<T>(token: Token): T;
}

/** The override spec accepted by `.register(token, spec)`. */
export type OverrideSpec<T> =
  | { readonly useFactory: (scope: ResolveScope) => T; readonly tag?: string }
  | { readonly useValue: T };
