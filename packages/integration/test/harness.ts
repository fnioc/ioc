// Integration harness — drives the REAL `tspc` (ts-patch's patched compiler)
// over a temp project that wires `@fnioc/core` + `@fnioc/di` + `@fnioc/transformer`
// into its node_modules, compiles a type-driven sample WITH the transformer
// plugin, and returns both the emitted JS text (for ABI-shape assertions) and a
// way to LOAD that lowered output so it can run against the di engine.
//
// This extends the transformer package's own e2e harness (which only links core +
// transformer and asserts on emitted text). The integration story needs the
// lowered output to actually execute against di, so the harness additionally
// links di and writes a `bunfig`-free ESM project whose compiled `dist/` is
// importable as plain Node ESM.

import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const PKG_ROOT = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(PKG_ROOT, "..", "..");
const TSPC = join(PKG_ROOT, "node_modules", "ts-patch", "bin", "tspc.js");

/** One source file in the temp project, keyed by its path under `src/`. */
export type SampleFiles = Record<string, string>;

export interface CompiledProject {
  /** The temp project root on disk. */
  readonly projDir: string;
  /** Reads an emitted JS file's text from `dist/` (path relative to `dist/`). */
  readonly emitted: (relPath: string) => string;
  /**
   * Dynamically imports an emitted module from `dist/` (path relative to
   * `dist/`, without extension or with `.js`). The module runs against the real
   * `@fnioc/di` engine linked into the project.
   */
  readonly load: (relPath: string) => Promise<Record<string, unknown>>;
  /** Tears down the temp project. */
  readonly cleanup: () => void;
}

function link(target: string, linkPath: string): void {
  try {
    symlinkSync(target, linkPath);
  } catch {
    // Ignore EEXIST from a re-run; the link target is stable.
  }
}

/**
 * Compile `files` (a `src/`-relative map) with the transformer plugin via tspc,
 * emitting ESM into `dist/`. Returns handles to read and dynamically import the
 * lowered output. Throws (surfacing tspc stdout/stderr) when compilation fails.
 */
export function compileWithTransformer(files: SampleFiles): CompiledProject {
  const projDir = mkdtempSync(join(tmpdir(), "fnioc-integration-"));
  const nm = join(projDir, "node_modules");
  mkdirSync(join(nm, "@fnioc"), { recursive: true });
  mkdirSync(join(projDir, "src"), { recursive: true });

  // Wire the temp project's node_modules to the real packages + tools. di is
  // linked (vs. the transformer's own e2e harness) so the lowered output runs.
  link(join(REPO_ROOT, "node_modules", "typescript"), join(nm, "typescript"));
  link(join(PKG_ROOT, "node_modules", "ts-patch"), join(nm, "ts-patch"));
  link(join(REPO_ROOT, "packages", "transformer"), join(nm, "@fnioc", "transformer"));
  link(join(REPO_ROOT, "packages", "core"), join(nm, "@fnioc", "core"));
  link(join(REPO_ROOT, "packages", "di"), join(nm, "@fnioc", "di"));

  for (const [rel, source] of Object.entries(files)) {
    const dest = join(projDir, "src", rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, source);
  }

  // A `package.json` with `type: module` so Node treats emitted `.js` as ESM.
  writeFileSync(
    join(projDir, "package.json"),
    JSON.stringify({ name: "fnioc-integration-sample", type: "module", private: true }),
  );
  writeFileSync(
    join(projDir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        lib: ["ES2022", "ESNext.Disposable"],
        strict: true,
        outDir: "dist",
        rootDir: "src",
        skipLibCheck: true,
        noEmitOnError: false,
        experimentalDecorators: false,
        plugins: [{ transform: "@fnioc/transformer", import: "transform" }],
      },
      include: ["src/**/*"],
    }),
  );

  const result = spawnSync("node", [TSPC, "-p", "tsconfig.json"], {
    cwd: projDir,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const out = (result.stdout ?? "") + (result.stderr ?? "");
    rmSync(projDir, { recursive: true, force: true });
    throw new Error(`tspc failed (status ${result.status}):\n${out}`);
  }

  return {
    projDir,
    emitted: (relPath) => readFileSync(join(projDir, "dist", relPath), "utf8"),
    load: (relPath) => {
      const withExt = relPath.endsWith(".js") ? relPath : `${relPath}.js`;
      // A cache-busting query so repeated loads in one run see fresh module
      // state (top-level singletons reset between tests).
      const url = `file://${join(projDir, "dist", withExt)}?t=${Date.now()}-${Math.random()}`;
      return import(url) as Promise<Record<string, unknown>>;
    },
    cleanup: () => rmSync(projDir, { recursive: true, force: true }),
  };
}
