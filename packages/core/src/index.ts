// @fnioc/core — the ioc substrate and dependency-metadata ABI.
//
// Full implementation lands in Phase 1 (see PLAN.md): the global-symbol
// WeakMap, `defineDeps`, the `@signature` decorator, the `forCtor` fluent
// API, the `Token` type, and the `hole` sentinel. For now this exports only
// the ABI version constant so the package has a real, importable surface and
// the cross-package wiring can be smoke-tested.

/**
 * Coarse runtime-compatibility guard for the dependency-metadata wire format.
 * Bumped only on an actual ABI break — far rarer than a `@fnioc/core` semver
 * major. Also version-suffixes the global-symbol WeakMap key.
 */
export const ABI_VERSION = 1;
