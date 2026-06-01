// Rolls the public type surface of @fnioc/di into a single dist/index.d.ts with
// the private @fnioc/core inlined (no @fnioc/core import in the output). The
// @rhombus-toolkit type-only deps are likewise inlined. rollup-plugin-dts drives
// the TypeScript compiler with this package's tsconfig, so NodeNext `.js`
// specifiers resolve to the `.ts` sources through the workspace.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { dts } from "rollup-plugin-dts";

const PKG_ROOT = dirname(fileURLToPath(import.meta.url));

export default {
  input: join(PKG_ROOT, "src", "index.ts"),
  output: { file: join(PKG_ROOT, "dist", "index.d.ts"), format: "es" },
  plugins: [
    dts({
      tsconfig: join(PKG_ROOT, "tsconfig.json"),
      respectExternal: true,
    }),
  ],
};
