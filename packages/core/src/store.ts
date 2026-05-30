import type { DepRecord } from "./types.js";

/**
 * Coarse runtime-compatibility guard for the dependency-metadata wire format.
 *
 * Bumped only on an actual ABI break — far rarer than a `@fnioc/core` semver
 * major. Also version-suffixes the global-symbol WeakMap key so that two copies
 * of `@fnioc/core` at the same ABI_VERSION share ONE WeakMap (the dual-package
 * hardening), while copies at different ABI_VERSIONs remain isolated by design.
 */
export const ABI_VERSION = 1;

/**
 * The hole sentinel: marks a constructor parameter as caller-supplied rather
 * than container-resolved. Wire value is `null` (JSON-friendly).
 *
 * Used in signatures to communicate "this position is a hole — the factory
 * caller supplies this argument, not the DI container."
 *
 * @example
 * ```ts
 * @signature("pkg:ILogger", hole, "pkg:IDb")
 * class SqlRepo { constructor(log: ILogger, tableName: string, db: IDb) { ... } }
 * ```
 */
export const hole = null as null;

// ── Global-symbol WeakMap ────────────────────────────────────────────────────
//
// Anchored on globalThis under a version-suffixed Symbol.for key.
//
// Why Symbol.for and never Symbol():
//   A unique symbol would fragment the map between two copies of @fnioc/core
//   loaded into the same runtime (the dual-package hazard). Symbol.for entries
//   live in the global symbol registry; two copies of @fnioc/core@1 in the same
//   process will find the same symbol and therefore the same WeakMap.
//
// Why ABI_VERSION in the key:
//   A v1 core and a hypothetical v2 core produce different keys and therefore
//   different WeakMaps. They remain isolated by design — different wire formats
//   must not mix.

const GLOBAL_KEY = Symbol.for(`@fnioc/core:deps@${ABI_VERSION}`);

export const store: WeakMap<Function, DepRecord> =
  ((globalThis as Record<symbol, unknown>)[GLOBAL_KEY] ??=
    new WeakMap()) as WeakMap<Function, DepRecord>;
