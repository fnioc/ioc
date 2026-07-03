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
export type { ServiceManifestCtor } from "./builder.js";

// The authoring TYPE-machinery lives in the pure-types @fnioc/core package (the
// abstractions surface a library author depends on). Re-exported here so a di
// consumer reaches the whole authoring surface through the single @fnioc/di
// import, exactly as before the split.
export type {
  AddBuilder,
  ProperCase,
  ScopeAddAuthoring,
  ScopeAddMethods,
  ScopeGuard,
  ServiceManifestBase,
  ValidScopes,
} from "@fnioc/core";

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
  AsyncResolutionRequiredError,
  OpenTokenResolutionError,
  OpenTokenRegistrationError,
} from "./errors.js";

// The slot/token RUNTIME helpers now live in di's own source (relocated from the
// pure-types @fnioc/core). di re-exports them for one-import authoring ergonomics
// — a di consumer reaches the slot builders (`union`/`typeArg`), the DepSlot type
// guards, and the token-grammar helpers from here. A core-only library author
// authors the same slot shapes as plain data literals instead.
export { union, typeArg } from "./slots.js";
export {
  isFactoryRef,
  isScopeRef,
  isUnionSlot,
  isLiteralRef,
  isTypeArgRef,
} from "./guards.js";
export {
  closeToken,
  parseToken,
  isOpenToken,
  substituteToken,
  substituteSignatures,
} from "./tokens.js";

// The ABI TYPES stay in @fnioc/core (pure types); di re-exports them so the whole
// surface is reachable through one @fnioc/di import.
export type {
  Token,
  DepRecord,
  DepSlot,
  Union,
  ParsedToken,
  Inject,
  Hole,
  $,
  Typeof,
  TypeArgRef,
} from "@fnioc/core";
