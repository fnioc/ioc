// Build @fnioc/transformer for publication.
//
// The transformer runs at COMPILE time inside ts-patch; `typescript` is its only
// runtime dep and stays external (a peer dep). Its source carries no @fnioc/core
// runtime import — the `@fnioc/di` reference it emits lives in generated strings,
// not in its own code — so the bundled artifacts are naturally free of @fnioc
// imports. The build asserts that invariant.
//
//   1. dist/index.js   — `bun build`, ESM, node target, `typescript` external.
//   2. dist/index.d.ts — rollup-plugin-dts rollup, `typescript` external.

import { rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const PKG_ROOT = import.meta.dir;
const DIST = join(PKG_ROOT, "dist");
const ENTRY = join(PKG_ROOT, "src", "index.ts");

rmSync(DIST, { recursive: true, force: true });

// 1. JS bundle — typescript external; no @fnioc imports in the source to inline.
const js = await Bun.build({
  entrypoints: [ENTRY],
  outdir: DIST,
  target: "node",
  format: "esm",
  external: ["typescript"],
});
if (!js.success) {
  for (const log of js.logs) console.error(log);
  throw new Error("@fnioc/transformer: bun build failed");
}

// 2. Rolled-up .d.ts — typescript external.
const dts = spawnSync(
  "bun",
  ["x", "rollup", "-c", join(PKG_ROOT, "rollup.dts.mjs")],
  { cwd: PKG_ROOT, stdio: "inherit" },
);
if (dts.status !== 0) {
  throw new Error("@fnioc/transformer: rollup d.ts bundling failed");
}
