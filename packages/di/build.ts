// Build @fnioc/di for publication.
//
// Two outputs, both with the private @fnioc/core INLINED (zero @fnioc/core
// references in the shipped artifacts — core is never published):
//
//   1. dist/index.js   — `bun build` bundles the ESM entry. @fnioc/core resolves
//      through the workspace to its TS source and is bundled in.
//      @rhombus-toolkit/type-guards contributes one tiny runtime helper
//      (`assertNever`) that is likewise inlined; @rhombus-toolkit/func is
//      type-only and erases. Nothing is externalized.
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
  // No external: @fnioc/core must be bundled, and the only @rhombus-toolkit
  // runtime import (type-guards' `assertNever`) is a trivial helper we inline
  // too (func is type-only and erases).
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
