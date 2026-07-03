// The type-level authoring surface a LIBRARY AUTHOR depends on to type a
// registration setup function WITHOUT pulling the `@fnioc/di` runtime. Every
// export here is pure type-level machinery — it erases completely.
//
// A lib author writes a free function that contributes registrations to a
// caller-owned manifest:
//
//   import type { ServiceManifest } from "@fnioc/core";
//   export function addMyServices(sc: ServiceManifest<"singleton">): void {
//     sc.add("pkg:IThing", Thing, [["pkg:IDep"]]).as("singleton");
//   }
//
// The application supplies a real `@fnioc/di` `ServiceManifest` value; its class
// structurally satisfies the `ServiceManifestBase` interface below. Slots are
// authored as plain data literals typed by `DepSlot` — no runtime helper import
// is needed.

import type { Ctor, Func } from "@rhombus-toolkit/func";
import type { DepSlot, Token } from "./types.js";

/**
 * Capitalize the first character of a string literal type, leaving the rest
 * untouched (`"request"` → `"Request"`). Used to mint a per-scope method name
 * `add${ProperCase<K>}` from a scope tag `K`. Because every scope tag is
 * guarded lowercase-first (`ValidScopes`), this map is INJECTIVE — two distinct
 * tags never collide on one minted name.
 */
export type ProperCase<T extends string> = T extends `${infer H}${infer R}`
  ? `${Uppercase<H>}${R}`
  : T;

/**
 * EMPTY carrier interface the `@fnioc/transformer` augments with the AUTHORED
 * single-arg call signatures for a per-scope `add${ProperCase<K>}` method
 * (`addRequest(C)` / `addRequest(fn)`). Like the other authoring forms, those
 * signatures are PURE TYPINGS contributed only when the transformer is in the
 * program — without it, a per-scope method exposes just the runtime two-arg
 * `(token, ctor) => void` shape. `S` is the full scope union, `K` the specific
 * scope this method tags with.
 */
export interface ScopeAddAuthoring<S extends string, K extends S> {}

/**
 * The per-scope registration methods minted from the scope union `S`. For each
 * tag `K`, a method named `add${ProperCase<K>}` whose runtime shape is
 * `(token, ctor) => void` (≡ `add(token, ctor).as(K)`), intersected with the
 * transformer-contributed `ScopeAddAuthoring<S, K>` authored single-arg forms.
 * The scope is baked into the name, so there is no `.as()` continuation — the
 * methods return `void`.
 */
export type ScopeAddMethods<S extends string> = {
  [K in S as `add${ProperCase<K>}`]: ((token: Token, ctor: Ctor) => void) &
    ScopeAddAuthoring<S, K>;
};

/**
 * The scope-union guard. A `ServiceManifest<S>` is only well-formed when every member
 * of `S` can mint a usable, non-colliding `add${ProperCase<K>}` method. `S`
 * resolves to itself when valid, else to `never` — which makes
 * `new ServiceManifest<S>()` a compile error at the construction site.
 *
 * Two rules, both checked NON-distributively (`[S] extends [...]`) so a union is
 * judged as a whole rather than member-by-member:
 *   - lowercase-first: every member must satisfy `K extends Uncapitalize<K>`.
 *     This makes `ProperCase` injective (no two tags collapse onto one method
 *     name) and keeps the transformer's uncapitalize-first scope recovery exact.
 *   - no collision: a member may not be `""` | `"factory"` | `"value"`, which
 *     would mint `add` / `addFactory` / `addValue` — the existing methods.
 */
export type ValidScopes<S extends string> = [S] extends [Uncapitalize<S>]
  ? [S & ("" | "factory" | "value")] extends [never]
    ? S
    : never
  : never;

/**
 * The continuation returned by a class `ServiceManifest.add`. Carries the just-added
 * registration so `.as()` can attach its lifetime in place. An `.add()` with no
 * trailing `.as()` leaves the registration scopeless ⇒ transient.
 *
 * `Scopes` is threaded so `.as()` only accepts a declared scope name —
 * compile-time guard at the registration site.
 */
export interface AddBuilder<Scopes extends string> {
  /**
   * Attaches the lifetime — the RUNTIME (lowered) form. Must name a declared
   * scope.
   *
   * `.as("singleton")` is what the engine executes: the transformer rewrites the
   * authored type-arg form (`.as<"singleton">()`) to this value-arg form before
   * runtime, and a plugin-less caller writes it directly. The AUTHORED type-arg
   * form (`.as<S extends Scopes>(): void`) is a PURE TYPING contributed by the
   * `@fnioc/transformer` augmentation — it is not part of di's published surface,
   * so it only type-checks when the transformer's types are in the program.
   */
  as(scope: Scopes): void;
}

/**
 * A construction-site guard parameter that carries the `ValidScopes` verdict.
 * When `S` is a valid scope union, `ValidScopes<S>` resolves to `S` (not
 * `never`), so the guard is an EMPTY rest tuple — `new ServiceManifest<S>()` takes no
 * args. When `S` is invalid, `ValidScopes<S>` collapses to `never`, and the
 * guard becomes a REQUIRED arg whose name spells out the error, so the no-arg
 * `new ServiceManifest<S>()` fails to type-check at the construction site.
 *
 * This expresses the same intent as a self-referential `S extends ValidScopes<S>`
 * constraint, which TypeScript rejects as circular (TS2313) and which silently
 * stops validating — the guard-param form is the working equivalent.
 */
export type ScopeGuard<S extends string> = [ValidScopes<S>] extends [never]
  ? [
      error: "invalid ServiceManifest scope tag: every member must be lowercase-first and not \"\" / \"factory\" / \"value\"",
    ]
  : [];

/**
 * The AUTHORING INTERFACE for the registration collection — the base surface a
 * lib author types a setup function against, and the interface `@fnioc/di`'s
 * `ServiceManifestClass` implements. It names the three runtime registration
 * methods (`add` / `addFactory` / `addValue`) plus `build`.
 *
 * `Provider` is the type `build()` returns. A core-only lib author never calls
 * `build()` (the application does), so it defaults to `unknown`; `@fnioc/di`
 * binds it to the concrete `ServiceProvider<Scopes>` when its class implements
 * this interface. Keeping it generic is what lets this interface live in the
 * types-only substrate without referencing di's runtime provider type.
 */
export interface ServiceManifestBase<
  Scopes extends string = "singleton",
  Provider = unknown,
> {
  /**
   * Class registration — a string token bound to a concrete constructor. The
   * optional third `signatures` arg carries the positional dep signatures ON the
   * registration (a lib author authors them as plain `DepSlot` data literals).
   */
  add(
    token: Token,
    ctor: Ctor,
    signatures?: readonly (readonly DepSlot[])[],
  ): AddBuilder<Scopes>;
  /**
   * Factory registration — a string token bound to a factory function, its call
   * parameters injected by the optional third `signatures` arg.
   */
  addFactory(
    token: Token,
    factory: Func<any[], unknown>,
    signatures?: readonly (readonly DepSlot[])[],
  ): AddBuilder<Scopes>;
  /** Value registration — an already-built instance, no deps and no lifetime. */
  addValue(token: Token, value: unknown): void;
  /** Seals the collection and returns the built provider. */
  build(): Provider;
}

/**
 * The full public authoring TYPE: the base collection interface intersected with
 * the per-scope `add${ProperCase<K>}` methods minted from `S`. A type alias (not
 * an interface) because an interface cannot extend a generic MAPPED type, and
 * `ScopeAddMethods` is one.
 */
export type ServiceManifest<
  Scopes extends string = "singleton",
  Provider = unknown,
> = ServiceManifestBase<Scopes, Provider> & ScopeAddMethods<Scopes>;

/**
 * The static / constructor side of the public `ServiceManifest`. The value
 * export in `@fnioc/di` carries the `ValidScopes` guard on its type parameter:
 * `new ServiceManifest<S>()` only type-checks when `S` is a valid scope union
 * (lowercase-first, no collision with `add`/`addFactory`/`addValue`).
 */
export interface ServiceManifestCtor {
  new <S extends string = "singleton">(...guard: ScopeGuard<S>): ServiceManifest<S>;
}
