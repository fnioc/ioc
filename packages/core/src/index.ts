/**
 * @fnioc/core — the immutable substrate and dependency-metadata ABI.
 *
 * Exports:
 *   - `Token`          — string alias for a DI key
 *   - `hole`           — null sentinel for caller-supplied constructor parameters
 *   - `ABI_VERSION`    — integer compatibility guard for the global WeakMap key
 *   - `DepRecord`      — shape of per-constructor metadata in the WeakMap
 *   - `defineDeps`     — the single write path into the global WeakMap
 *   - `getDeps`        — the read path (consumed by @fnioc/di)
 *   - `signature`      — TC39 class decorator factory
 *   - `ForCtorBuilder` — return type of `forCtor`
 *   - `forCtor`        — fluent free-function for third-party classes
 */

export type { Token, DepRecord } from "./types.js";
export { ABI_VERSION, hole } from "./store.js";
export { defineDeps, getDeps } from "./defineDeps.js";
export { signature } from "./signature.js";
export type { ForCtorBuilder } from "./forCtor.js";
export { forCtor } from "./forCtor.js";
