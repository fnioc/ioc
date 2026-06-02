import type { DepRecord, DepTarget } from "./types.js";

/**
 * The hole sentinel: marks a constructor parameter as caller-supplied rather
 * than container-resolved.
 *
 * Used in signatures to communicate "this position is a hole — the factory
 * caller supplies this argument, not the DI container." Detected by identity
 * (`slot === hole`), and `null` is the sentinel value: it is exactly what the
 * transformer emits for a hole slot, so the authoring surface and the lowered
 * output agree on one representation.
 *
 * @example
 * ```ts
 * @signature("pkg:ILogger", hole, "pkg:IDb")
 * class SqlRepo { constructor(log: ILogger, tableName: string, db: IDb) { ... } }
 * ```
 */
export const hole = null as null;

// ── Global-symbol metadata store ─────────────────────────────────────────────
//
// Anchored on globalThis under a Symbol.for key.
//
// Why Symbol.for and never Symbol():
//   A unique symbol would fragment the map between two copies of @fnioc/core
//   loaded into the same runtime (the dual-package hazard). Symbol.for entries
//   live in the global symbol registry; two copies of @fnioc/core in the same
//   process will find the same symbol and therefore the same store.
//
// Why a regular Map and not a WeakMap:
//   Every key is a ctor or factory function that is pinned for the module's
//   lifetime — a class is a module binding, an `@signature`/`forCtor` target is
//   a named declaration, and a transformer-lowered factory is hoisted into a
//   module-level `const`. So no key ever becomes unreachable; a WeakMap could
//   never collect an entry, making its weakness pure ceremony. DI metadata is
//   registered once at startup and lives for the process by design, so a plain
//   Map's non-collection is correct, not a leak.

const GLOBAL_KEY: unique symbol = Symbol.for("fnioc:deps");
const globals = globalThis as typeof globalThis & {
  [GLOBAL_KEY]?: Map<DepTarget, DepRecord>;
};

export const store: Map<DepTarget, DepRecord> = (globals[GLOBAL_KEY] ??=
  new Map<DepTarget, DepRecord>());
