// @fnioc/di — the ioc runtime engine.
//
// Consumes the plain-data ABI emitted by @fnioc/transformer (or hand-fed via
// @fnioc/core's authoring surfaces) and resolves the dependency graph. Never
// touches a TypeScript type — works purely on string tokens and the positional
// DepRecord signatures in the global-symbol Map.
//
// Phase 2A scope: registration, the scope chain + scoped lifetimes, resolution
// (a tag whose frame is not open resolves transiently), greedy signature
// selection, cycle detection, the useFactory/useValue registration shapes, and
// native disposal.
//
// Phase 2D.2 adds factory injection (a ctor param typed `() => IFoo` becomes an
// injected callable) and caller-supplied parameter support via the FactoryRef
// params list.
//
// Container redesign: `Scope` is now a pure frame (cache + disposal + parent
// link), and `ServiceProvider` is the public container surface implementing
// `Resolver` + `ScopeFactory` + Disposable.

export { ServiceManifest, ServiceManifestClass } from "./builder.js";
export type {
  AddBuilder,
  ServiceManifestCtor,
  ProperCase,
  ScopeAddAuthoring,
  ScopeAddMethods,
  ScopeGuard,
  ValidScopes,
} from "./builder.js";

export { ServiceProvider, Scope } from "./scope.js";

export type {
  Ctor,
  Factory,
  Registration,
  ClassRegistration,
  FactoryRegistration,
  ValueRegistration,
  OpenRegistration,
  Resolver,
  ScopeFactory,
  Lifetime,
  // Backwards-compat alias.
  ResolveScope,
} from "./types.js";

export {
  DiError,
  UnregisteredTokenError,
  MissingMetadataError,
  NoSatisfiableSignatureError,
  NoSatisfiableUnionError,
  FactoryTargetError,
  CircularDependencyError,
  AsyncDisposalRequiredError,
  OpenTokenResolutionError,
  OpenTokenRegistrationError,
} from "./errors.js";

// Re-exported from @fnioc/core for one-import authoring ergonomics — AND
// because core is private (source-only, inlined at build): di is the public
// gateway to the ABI surface. The metadata writers are pure functions with
// zero resolution dependency; the token-grammar helpers (closeToken/parseToken
// /isOpenToken/substituteToken/substituteSignatures) and the open-generics
// authoring types (Hole/$/Typeof/TypeArgRef) live in core to keep the
// ABI self-contained, but users reach them from here.
export {
  signature,
  forCtor,
  defineDeps,
  union,
  typeArg,
  isTypeArgRef,
  closeToken,
  parseToken,
  isOpenToken,
  substituteToken,
  substituteSignatures,
} from "@fnioc/core";
export type {
  Token,
  DepRecord,
  DepSlot,
  ForCtorBuilder,
  Union,
  ParsedToken,
  Inject,
  Hole,
  $,
  Typeof,
  TypeArgRef,
} from "@fnioc/core";
