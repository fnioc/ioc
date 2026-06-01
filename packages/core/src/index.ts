/**
 * @fnioc/core — the immutable substrate and dependency-metadata format.
 *
 * Exports:
 *   - `Token`          — string alias for a DI key
 *   - `FactoryRef`     — marks a signature slot as a factory-injected parameter
 *   - `ScopeRef`       — marks a signature slot as the live resolution scope
 *   - `DepSlot`        — one positional slot: Token | hole | FactoryRef | ScopeRef
 *   - `DepTarget`      — a ctor or factory function metadata attaches to
 *   - `hole`           — `null` sentinel for caller-supplied params
 *   - `DepRecord`      — shape of per-constructor metadata in the WeakMap
 *   - `defineDeps`     — the single write path into the global WeakMap
 *   - `getDeps`        — the read path (consumed by @fnioc/di)
 *   - `signature`      — TC39 class decorator factory
 *   - `ForCtorBuilder` — return type of `forCtor`
 *   - `forCtor`        — fluent free-function for third-party classes
 */

export type {
  Token,
  FactoryRef,
  ScopeRef,
  DepSlot,
  DepTarget,
  DepRecord,
} from "./types.js";
export { hole } from "./store.js";
export { defineDeps, getDeps } from "./defineDeps.js";
export { signature } from "./signature.js";
export type { ForCtorBuilder } from "./forCtor.js";
export { forCtor } from "./forCtor.js";
