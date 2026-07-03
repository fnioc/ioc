// Build @fnioc/di for publication.
//
// Two outputs. @fnioc/core is now a PURE-TYPES package — di's runtime (the slot
// builders, DepSlot guards, and token grammar) lives in di's OWN source, so the
// JS bundle carries no @fnioc/core code at all; only core's TYPES are referenced,
// and they are inlined into the rolled-up .d.ts so the published artifacts have
// no @fnioc/core import.
//
//   1. dist/index.js   — `bun build` bundles the ESM entry. di imports only TYPES
//      from @fnioc/core (they erase); `assertNever` is a local 2-liner;
//      @rhombus-toolkit/func is type-only and erases. Nothing is externalized.
//   2. dist/index.d.ts — rollup-plugin-dts rolls the public type surface into one
//      declaration file, inlining @fnioc/core's (and the type-only
//      @rhombus-toolkit) types so the published d.ts has no external import.

import { rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const PKG_ROOT = import.meta.dir;
const DIST = join(PKG_ROOT, "dist");
const ENTRY = join(PKG_ROOT, "src", "index.ts");

rmSync(DIST, { recursive: true, force: true });

// 1. JS bundle — core inlined, ESM, node target.
const js = await Bun.build({
  entrypoints: [ENTRY],
  outdir: DIST,
  target: "node",
  format: "esm",
  // No external: @fnioc/core must be bundled; the only runtime helper
  // (`assertNever`) is a local 2-liner (func is type-only and erases).
});
if (!js.success) {
  for (const log of js.logs) console.error(log);
  throw new Error("@fnioc/di: bun build failed");
}

// 2. Rolled-up .d.ts — core's types inlined into one file, no @fnioc/core import.
const dts = spawnSync(
  "bun",
  ["x", "rollup", "-c", join(PKG_ROOT, "rollup.dts.mjs")],
  { cwd: PKG_ROOT, stdio: "inherit" },
);
if (dts.status !== 0) {
  throw new Error("@fnioc/di: rollup d.ts bundling failed");
}
