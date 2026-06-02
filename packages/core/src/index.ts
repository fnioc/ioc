/**
 * @fnioc/core — the immutable substrate and dependency-metadata format.
 *
 * Exports:
 *   - `Token`          — string alias for a DI key
 *   - `FactoryRef`     — marks a signature slot as a factory-injected parameter
 *   - `ScopeRef`       — marks a signature slot as the live resolution scope
 *   - `Union`          — member-level alternative slots tried in declaration order
 *   - `DepSlot`        — one positional slot: Token | FactoryRef | ScopeRef | Union
 *   - `Inject`         — compile-time brand that pins a token for one arg
 *   - `DepTarget`      — a ctor or factory function metadata attaches to
 *   - `DepRecord`      — shape of per-constructor metadata in the WeakMap
 *   - `defineDeps`     — the single write path into the global WeakMap
 *   - `getDeps`        — the read path (consumed by @fnioc/di)
 *   - `union`          — runtime helper: constructs a Union slot from member slots
 *   - `isFactoryRef`   — type guard for FactoryRef slots
 *   - `isScopeRef`     — type guard for ScopeRef slots
 *   - `isUnionSlot`    — type guard for Union slots
 *   - `signature`      — TC39 class decorator factory
 *   - `ForCtorBuilder` — return type of `forCtor`
 *   - `forCtor`        — fluent free-function for third-party classes
 */

import type { DepSlot, Union } from "./types.js";

export type {
  Token,
  FactoryRef,
  ScopeRef,
  Union,
  DepSlot,
  DepTarget,
  DepRecord,
  Inject,
} from "./types.js";
export { defineDeps, getDeps, isFactoryRef, isScopeRef, isUnionSlot } from "./defineDeps.js";
export { signature } from "./signature.js";
export type { ForCtorBuilder } from "./forCtor.js";
export { forCtor } from "./forCtor.js";

/**
 * Constructs a `Union` slot — a set of alternative dependency slots tried in
 * declaration order. The first resolvable member wins; if none is resolvable,
 * resolution throws.
 *
 * @example
 * ```ts
 * forCtor(Handler).signature(
 *   union("pkg:IRedis", "pkg:IMemoryCache"),
 *   "pkg:ILogger",
 * );
 * ```
 */
export function union(...slots: DepSlot[]): Union {
  return { union: slots };
}
