// Build @fnioc/core for publication.
//
// core is a PURE-TYPES package — it ships ZERO runtime. The only artifact is a
// single self-contained declaration file:
//
//   dist/index.d.ts — rollup-plugin-dts rolls core's public type surface into one
//   .d.ts, inlining the type-only @rhombus-toolkit/func types so the published
//   declaration has no external import and core carries no dependencies.
//
// There is deliberately NO dist/index.js — nothing imports core at runtime (every
// consumer uses `import type`), so emitting one would contradict the zero-runtime
// invariant this build asserts.

import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const PKG_ROOT = import.meta.dir;
const DIST = join(PKG_ROOT, "dist");

rmSync(DIST, { recursive: true, force: true });

// Rolled-up .d.ts — func's types inlined, no external import.
const dts = spawnSync(
  "bun",
  ["x", "rollup", "-c", join(PKG_ROOT, "rollup.dts.mjs")],
  { cwd: PKG_ROOT, stdio: "inherit" },
);
if (dts.status !== 0) {
  throw new Error("@fnioc/core: rollup d.ts bundling failed");
}

// Assert the zero-runtime invariant: the build must emit ONLY dist/index.d.ts.
if (existsSync(join(DIST, "index.js"))) {
  throw new Error("@fnioc/core: unexpected runtime artifact dist/index.js — core is types-only");
}
