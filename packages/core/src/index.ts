/**
 * @fnioc/core — the PURE-TYPES abstractions substrate.
 *
 * A LIBRARY AUTHOR depends on this package (`import type`) to author
 * registrations and dependency signatures WITHOUT pulling the `@fnioc/di`
 * runtime. It ships ZERO runtime values — only types and the authoring type
 * machinery. The token grammar and slot constructors that used to live here
 * (`union`, `typeArg`, `parseToken`, …) are runtime and now live in `@fnioc/di`.
 *
 * Exports (all types):
 *   - `Token`          — string alias for a DI key
 *   - `DepSlot`        — one positional signature slot
 *   - `FactoryRef` / `ScopeRef` / `Union` / `LiteralRef` / `TypeArgRef` — slot kinds
 *   - `DepTarget` / `DepRecord` — dep-metadata shapes
 *   - `ParsedToken`    — the parse result shape for a closed-generic token
 *   - `Inject` / `Hole` / `$` / `Typeof` — compile-time authoring brands
 *   - `OverloadedParameters` / `OverloadedConstructorParameters` — overload-faithful
 *     parameter-tuple unions (every overload, not just the last)
 *   - the authoring surface: `ServiceManifest`, `ServiceManifestBase`,
 *     `ServiceManifestCtor`, `AddBuilder`, `ScopeAddMethods`, `ScopeAddAuthoring`,
 *     `ProperCase`, `ValidScopes`, `ScopeGuard`
 */

export type {
  Token,
  FactoryRef,
  ScopeRef,
  Union,
  LiteralRef,
  TypeArgRef,
  DepSlot,
  DepTarget,
  DepRecord,
  ParsedToken,
  Inject,
  Hole,
  $,
  Typeof,
  OverloadedParameters,
  OverloadedConstructorParameters,
} from "./types.js";

export type {
  ProperCase,
  ScopeAddAuthoring,
  ScopeAddMethods,
  ValidScopes,
  AddBuilder,
  ScopeGuard,
  ServiceManifestBase,
  ServiceManifest,
  ServiceManifestCtor,
} from "./authoring.js";
