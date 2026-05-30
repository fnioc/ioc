// @fnioc/di — the ioc runtime engine.
//
// Consumes the plain-data ABI emitted by @fnioc/transformer (or hand-fed via
// @fnioc/core's authoring surfaces) and resolves the dependency graph. Never
// touches a TypeScript type — works purely on string tokens and the positional
// DepRecord signatures in the global WeakMap.
//
// Phase 2A scope: registration, the scope chain + tagged lifetimes, resolution
// with the captive-dependency rule, greedy signature selection, cycle
// detection, the useFactory/useValue overrides, and native disposal. Factory
// injection (a ctor param typed `() => IFoo` becoming an injected factory) and
// hole-filling are deferred to Phase 2D — see the `// Phase 2D:` markers in
// scope.ts.

export { DiBuilder } from "./builder.js";
export type { AddBuilder } from "./builder.js";

export { Scope } from "./scope.js";

export type {
  Ctor,
  Factory,
  OverrideSpec,
  Registration,
  ClassRegistration,
  FactoryRegistration,
  ValueRegistration,
  ResolveScope,
} from "./types.js";

export {
  DiError,
  UnregisteredTokenError,
  MissingScopeError,
  MissingMetadataError,
  NoSatisfiableSignatureError,
  CircularDependencyError,
  AsyncDisposalRequiredError,
} from "./errors.js";

// Re-exported from @fnioc/core for one-import authoring ergonomics. These are
// pure metadata writers with zero resolution dependency; living in `core` keeps
// the ABI self-contained, but consumers writing both registrations and manual
// annotations get them from a single import here.
export { signature, forCtor, hole } from "@fnioc/core";
export type { Token, DepRecord, ForCtorBuilder } from "@fnioc/core";
