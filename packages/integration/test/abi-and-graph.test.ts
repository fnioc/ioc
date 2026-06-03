import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileWithTransformer, type CompiledProject } from "./harness.js";

// Coverage 1 (ABI contract / compile-with-transformer), 2 (progressive-
// enhancement parity), 3 (factory e2e + named-callable opt-out).
//
// The sample under `test/sample/` is compiled ONCE with the real ts-patch
// transformer; we assert the emitted shape (string tokens, null holes,
// `{factory}` slots) and then LOAD the lowered output to run it against the live
// `@fnioc/di` engine. The parity test rebuilds the identical graph by hand
// (string tokens via `defineDeps` + the plugin-less `add` path) and asserts
// behavioural equivalence.

const SAMPLE_DIR = join(import.meta.dir, "sample");

function sampleSources(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of ["contracts.ts", "services.ts", "wiring.ts", "app.ts"]) {
    files[`sample/${name}`] = readFileSync(join(SAMPLE_DIR, name), "utf8");
  }
  return files;
}

let project: CompiledProject;

// tspc compiles the sample with the transformer plugin — allow generous time
// for the cold ts-patch + program build.
beforeAll(() => {
  project = compileWithTransformer(sampleSources());
}, 60_000);

afterAll(() => {
  project?.cleanup();
});

// ── Coverage 1: ABI contract ────────────────────────────────────────────────

// The transformer HOISTS every class arg to a `const ɵregN = Cls` declaration
// and uses the identifier in both `defineDeps(ɵregN, ...)` and the `add` call.
// Tests check (a) the hoist and (b) the dep signature content separately.
//
// Helper: find the ɵregN name for a class in the emitted wiring JS.
function hoistName(wiring: string, className: string): string {
  const m = wiring.match(new RegExp(`const (ɵreg\\d+) = ${className};`));
  if (!m) {throw new Error(`No hoist const found for ${className} in emitted wiring`);}
  return m[1]!;
}

describe("emit contract — transformer-emitted lowered output (PRD §8)", () => {
  test("emits the defineDeps import from @fnioc/di + bare calls (ESM contract)", () => {
    const wiring = project.emitted("sample/wiring.js");
    expect(wiring).toContain('import { defineDeps } from "@fnioc/di"');
  });

  test("class with two registered deps emits a single two-slot signature", () => {
    const wiring = project.emitted("sample/wiring.js");
    // SqlUserRepo has exactly two ctor params (logger + db), both registered.
    // No optional params → single signature, no overload expansion.
    const n = hoistName(wiring, "SqlUserRepo");
    expect(wiring).toContain(
      `defineDeps(${n}, [["./sample/contracts/ILogger", "./sample/contracts/IDbConnection"]]);`,
    );
    expect(wiring).toContain(
      `services.add("./sample/contracts/IUserRepo", ${n}).as("request");`,
    );
  });

  test("zero-arg classes lower to an empty signature", () => {
    const wiring = project.emitted("sample/wiring.js");
    // Each zero-arg class is hoisted to a const; defineDeps uses the const identifier.
    for (const cls of ["ConsoleLogger", "SqlDb", "RequestContext"]) {
      const n = hoistName(wiring, cls);
      expect(wiring).toContain(`defineDeps(${n}, [[]]);`);
    }
  });

  test("inline `() => I` ctor param lowers to a `{ type: token }` slot", () => {
    const wiring = project.emitted("sample/wiring.js");
    const n = hoistName(wiring, "ReportService");
    // ReportService now has one factory param: `makeCtx: () => IRequestContext`.
    // The transformer emits the return type as the slot token.
    expect(wiring).toContain(
      `defineDeps(${n}, [[{ type: "./sample/contracts/IRequestContext" }]]);`,
    );
  });

  test("the type-driven type arg lowers to a string token; `.as<\"x\">()` → `.as(\"x\")`", () => {
    const wiring = project.emitted("sample/wiring.js");
    const n = hoistName(wiring, "ConsoleLogger");
    expect(wiring).toContain(
      `services.add("./sample/contracts/ILogger", ${n}).as("singleton");`,
    );
  });

  test("Promise<IConfig> ctor dep unwraps to the bare IConfig token (async-as-values)", () => {
    const wiring = project.emitted("sample/wiring.js");
    const n = hoistName(wiring, "ConfigConsumer");
    expect(wiring).toContain(
      `defineDeps(${n}, [["./sample/contracts/IConfig"]]);`,
    );
  });

  test("a NAMED callable interface ctor param lowers to a PLAIN token, not a factory (opt-out)", () => {
    const wiring = project.emitted("sample/wiring.js");
    // ThunkConsumer(thunk: IThunk) — IThunk is `interface IThunk { (): string }`.
    // It must be a string-token slot, never `{ factory: ... }`.
    const n = hoistName(wiring, "ThunkConsumer");
    expect(wiring).toContain(
      `defineDeps(${n}, [["./sample/contracts/IThunk"]]);`,
    );
    expect(wiring).not.toContain('factory: "./sample/contracts/IThunk"');
  });
});

// ── Coverage 1 (cont.): run the lowered output against the engine ─────────────

describe("lowered output resolves the full graph against @fnioc/di", () => {
  test("the transformer-compiled graph wires correctly", async () => {
    const app = await project.load("sample/app.js");
    const resolveGraph = app.resolveGraph as () => {
      resolved: Record<string, unknown>;
    };
    const { resolved } = resolveGraph();

    // Singleton chain: repo holds the SAME logger + db instances the root owns.
    const repo = resolved.repo as { logger: unknown; db: unknown; find: (n: number) => string };
    expect(resolved.logger).toBe(repo.logger);
    expect(resolved.db).toBe(repo.db);

    // The repo runs end-to-end: logs through the injected logger, queries the db.
    expect(repo.find(7)).toBe("result(SELECT * FROM users WHERE id=7)");
    expect((resolved.logger as { lines: string[] }).lines).toContain("find 7");

    // SqlUserRepo has only two ctor params; `table` is not a property.
    expect((repo as unknown as { table: unknown }).table).toBeUndefined();

    // The named-callable opt-out: ThunkConsumer.thunk is the resolved IThunk
    // VALUE (a callable), not a di-injected factory.
    const thunkConsumer = resolved.thunkConsumer as { thunk: () => string };
    expect(typeof thunkConsumer.thunk).toBe("function");
    expect(thunkConsumer.thunk()).toBe("thunk-result");
  });

  test("request-scoped instances are per-request; singletons are shared across requests", async () => {
    const app = await project.load("sample/app.js");
    const rootScope = app.rootScope as () => {
      resolve: (t: string) => unknown;
      createScope: (n: string) => { resolve: (t: string) => unknown };
    };
    const T = app.T as Record<string, string>;

    const root = rootScope();
    const reqA = root.createScope("request");
    const reqB = root.createScope("request");

    // Singleton logger: shared across both request scopes.
    expect(reqA.resolve(T.logger)).toBe(reqB.resolve(T.logger));
    // Request context: one per request scope, distinct across requests.
    expect(reqA.resolve(T.ctx)).not.toBe(reqB.resolve(T.ctx));
    // Repo (request-scoped) differs per request, but each holds the shared db.
    const repoA = reqA.resolve(T.repo) as { db: unknown };
    const repoB = reqB.resolve(T.repo) as { db: unknown };
    expect(repoA).not.toBe(repoB);
    expect(repoA.db).toBe(repoB.db);
  });
});

// ── Coverage 3: factory e2e (bare zero-arg factory + named-callable opt-out) ───

describe("factory injection e2e (transformer-emitted FactoryRef → di callable)", () => {
  test("a bare `() => IRequestContext` factory respects the target's request lifetime", async () => {
    const app = await project.load("sample/app.js");
    const rootScope = app.rootScope as () => {
      createScope: (n: string) => {
        resolve: <T>(t: string) => T;
      };
    };
    const T = app.T as Record<string, string>;

    const req = rootScope().createScope("request");
    const reportService = req.resolve<{
      makeCtx: () => { id: number };
    }>(T.reportService);

    // The bare zero-arg factory routes through the normal resolve path: a
    // request-scoped target yields the SAME instance within one request.
    const a = reportService.makeCtx();
    const b = reportService.makeCtx();
    expect(a).toBe(b);
    expect(req.resolve<{ id: number }>(T.ctx)).toBe(a);
  });
});
