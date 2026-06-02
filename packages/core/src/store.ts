import type { DepRecord, DepTarget } from "./types.js";

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
