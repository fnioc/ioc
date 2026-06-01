// Shared runtime types for the engine: the concrete-constructor shape, the
// registration kinds, and the resolver-facing scope contract.

import type { Token } from "@fnioc/core";
import type { Ctor, Func } from "@rhombus-toolkit/func";

export type { Ctor };

/**
 * A factory override: a closure that builds the instance, given the scope it is
 * being resolved into (so the factory can `scope.resolve(...)` its own deps).
 *
 * May be async — it can return a `Promise<T>`. The container never awaits; the
 * Promise flows through the sync resolution channel as a value (§"Async as
 * values"). A consumer that depends on it declares `Promise<T>` and awaits.
 */
export type Factory<T = unknown> = Func<[scope: ResolveScope], T>;

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

/** A `useFactory` override registration. */
export interface FactoryRegistration {
  readonly kind: "factory";
  readonly useFactory: Factory;
  readonly scope: string | undefined;
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

/**
 * A factory registration spec: a `useFactory` closure (which resolves its own
 * deps from the scope passed to it) with an optional `scope` so its result is
 * cached at a matching ancestor (singleton-style). Without a `scope` it runs on
 * every resolve.
 */
export interface FactorySpec<T> {
  readonly useFactory: (scope: ResolveScope) => T;
  readonly scope?: string;
}

/** A value registration spec: an already-built instance, no lifetime. */
export interface ValueSpec<T> {
  readonly useValue: T;
}
