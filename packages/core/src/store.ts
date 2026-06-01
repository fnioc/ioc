import type { Ctor } from "@rhombus-toolkit/func";
import type { DepRecord } from "./types.js";

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

// ── Global-symbol WeakMap ────────────────────────────────────────────────────
//
// Anchored on globalThis under a Symbol.for key.
//
// Why Symbol.for and never Symbol():
//   A unique symbol would fragment the map between two copies of @fnioc/core
//   loaded into the same runtime (the dual-package hazard). Symbol.for entries
//   live in the global symbol registry; two copies of @fnioc/core in the same
//   process will find the same symbol and therefore the same WeakMap.

const GLOBAL_KEY: unique symbol = Symbol.for("fnioc:deps");
const globals = globalThis as typeof globalThis & {
  [GLOBAL_KEY]?: WeakMap<Ctor, DepRecord>;
};

export const store = (globals[GLOBAL_KEY] ??= new WeakMap());
