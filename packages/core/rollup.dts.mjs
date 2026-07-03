// Rolls the public type surface of @fnioc/core into a single dist/index.d.ts.
// The type-only @rhombus-toolkit/func types are inlined (respectExternal) so the
// published declaration has no external import and core ships with zero deps.
// rollup-plugin-dts drives the TypeScript compiler with this package's tsconfig,
// so NodeNext `.js` specifiers resolve to the `.ts` sources.

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
