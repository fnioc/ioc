// @fnioc/di — the ioc runtime engine.
//
// Consumes the plain-data ABI emitted by @fnioc/transformer (or hand-fed via
// @fnioc/core's authoring surfaces) and resolves the dependency graph. Never
// touches a TypeScript type — works purely on string tokens and the positional
// DepRecord signatures in the global WeakMap.
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

export { DiBuilder, DiBuilderClass } from "./builder.js";
export type {
  AddBuilder,
  DiBuilderCtor,
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
} from "./errors.js";

// Re-exported from @fnioc/core for one-import authoring ergonomics. These are
// pure metadata writers with zero resolution dependency; living in `core` keeps
// the ABI self-contained, but consumers writing both registrations and manual
// annotations get them from a single import here.
export { signature, forCtor, defineDeps, union } from "@fnioc/core";
export type { Token, DepRecord, ForCtorBuilder, Union } from "@fnioc/core";
