import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Production-path e2e: drives the REAL `tspc` (ts-patch's patched compiler) over
// a temp project that imports `@fnioc/transformer` as a ts-patch plugin, then
// asserts the emitted ESM matches the PRD §8 lowered-call contract exactly.
//
// This is the authoritative check that the installed ts-patch ↔ TypeScript pair
// works end-to-end (not just the in-memory harness). Tested pair: the package's
// pinned `ts-patch@^3.3.0` against the repo's `typescript@^5.9`.

const PKG_ROOT = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(PKG_ROOT, "..", "..");
const TSPC = join(PKG_ROOT, "node_modules", "ts-patch", "bin", "tspc.js");

let projDir: string;

function link(target: string, linkPath: string): void {
  try {
    symlinkSync(target, linkPath);
  } catch {
    // Ignore EEXIST from a re-run; the link target is stable.
  }
}

beforeAll(() => {
  projDir = mkdtempSync(join(tmpdir(), "fnioc-tsp-e2e-"));
  const nm = join(projDir, "node_modules");
  mkdirSync(join(nm, "@fnioc"), { recursive: true });
  mkdirSync(join(projDir, "src"), { recursive: true });

  // Wire the temp project's node_modules to the real packages + tools.
  link(join(REPO_ROOT, "node_modules", "typescript"), join(nm, "typescript"));
  link(join(PKG_ROOT, "node_modules", "ts-patch"), join(nm, "ts-patch"));
  link(PKG_ROOT, join(nm, "@fnioc", "transformer"));
  link(join(REPO_ROOT, "packages", "core"), join(nm, "@fnioc", "core"));

  writeFileSync(
    join(projDir, "src", "services.ts"),
    `
export interface ILogger {}
export interface IDbConnection {}
export interface IUserRepo {}
export interface IWidget {}
export class ConsoleLogger implements ILogger {}
export class SqlUserRepo implements IUserRepo {
  constructor(log: ILogger, db: IDbConnection, table: string) {}
}
export class WidgetHost implements IWidget {
  constructor(makeRepo: () => IUserRepo) {}
}
`,
  );
  writeFileSync(
    join(projDir, "src", "main.ts"),
    `
import { SqlUserRepo, ConsoleLogger, WidgetHost, ILogger, IUserRepo, IWidget } from "./services.js";
declare const services: {
  add<I>(c: new (...a: any[]) => I): { as<S extends string>(): void };
};
services.add<ILogger>(ConsoleLogger).as<"singleton">();
services.add<IUserRepo>(SqlUserRepo).as<"request">();
services.add<IWidget>(WidgetHost).as<"singleton">();
`,
  );
  writeFileSync(
    join(projDir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        outDir: "dist",
        rootDir: "src",
        skipLibCheck: true,
        noEmitOnError: false,
        plugins: [{ transform: "@fnioc/transformer", import: "transform" }],
      },
      include: ["src/**/*"],
    }),
  );
});

afterAll(() => {
  if (projDir) rmSync(projDir, { recursive: true, force: true });
});

describe("ts-patch production e2e (ESM)", () => {
  test("tspc compiles and emits the PRD §8 lowered contract", () => {
    const result = spawnSync("node", [TSPC, "-p", "tsconfig.json"], {
      cwd: projDir,
      encoding: "utf8",
    });
    // tspc should run cleanly (status 0); surface its output if not.
    expect(result.status, result.stdout + result.stderr).toBe(0);

    const emitted = readFileSync(join(projDir, "dist", "main.js"), "utf8");

    // The injected import + always-hoisted defineDeps calls (ESM contract).
    // Registrations are ordered: ɵreg0=ConsoleLogger, ɵreg1=SqlUserRepo,
    // ɵreg2=WidgetHost (declaration order in main.ts).
    expect(emitted).toContain('import { defineDeps } from "@fnioc/di"');
    expect(emitted).toContain("defineDeps(ɵreg0, [[]]);");
    // `table: string` now emits bare token "string" (wide-primitive→bare-token rule).
    expect(emitted).toContain(
      'defineDeps(ɵreg1, [["./services/ILogger", "./services/IDbConnection", "string"]]);',
    );
    // The lowered registrations reference the hoisted consts, not the raw classes.
    expect(emitted).toContain(
      'services.add("./services/ILogger", ɵreg0).as("singleton");',
    );
    expect(emitted).toContain(
      'services.add("./services/IUserRepo", ɵreg1).as("request");',
    );

    // An inline `() => IUserRepo` ctor param lowers to a FactoryRef slot keyed
    // on the return type's token (PRD §7).
    expect(emitted).toContain(
      'defineDeps(ɵreg2, [[{ factory: "./services/IUserRepo" }]]);',
    );
    expect(emitted).toContain(
      'services.add("./services/IWidget", ɵreg2).as("singleton");',
    );
  }, 30_000);
});
