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

describe("emit contract — transformer-emitted lowered output (PRD §8)", () => {
  test("emits the defineDeps import from @fnioc/di + bare calls (ESM contract)", () => {
    const wiring = project.emitted("sample/wiring.js");
    expect(wiring).toContain('import { defineDeps } from "@fnioc/di"');
  });

  test("class with mixed deps lowers to [tokens..., null] (a hole for the unregistered ctor param)", () => {
    const wiring = project.emitted("sample/wiring.js");
    expect(wiring).toContain(
      'defineDeps(SqlUserRepo, [["./sample/contracts/ILogger", "./sample/contracts/IDbConnection", null]]);',
    );
    expect(wiring).toContain(
      'services.add("./sample/contracts/IUserRepo", SqlUserRepo).as("request");',
    );
  });

  test("zero-arg classes lower to an empty signature", () => {
    const wiring = project.emitted("sample/wiring.js");
    expect(wiring).toContain("defineDeps(ConsoleLogger, [[]]);");
    expect(wiring).toContain("defineDeps(SqlDb, [[]]);");
    expect(wiring).toContain("defineDeps(RequestContext, [[]]);");
  });

  test("inline `() => I` ctor params lower to `{ factory: token }` slots", () => {
    const wiring = project.emitted("sample/wiring.js");
    expect(wiring).toContain(
      'defineDeps(ReportService, [[{ factory: "./sample/contracts/IRequestContext" }, { factory: "./sample/contracts/IReport" }]]);',
    );
  });

  test("the type-driven type arg lowers to a string token; `.as<\"x\">()` → `.as(\"x\")`", () => {
    const wiring = project.emitted("sample/wiring.js");
    expect(wiring).toContain(
      'services.add("./sample/contracts/ILogger", ConsoleLogger).as("singleton");',
    );
  });

  test("Promise<IConfig> ctor dep unwraps to the bare IConfig token (async-as-values)", () => {
    const wiring = project.emitted("sample/wiring.js");
    expect(wiring).toContain(
      'defineDeps(ConfigConsumer, [["./sample/contracts/IConfig"]]);',
    );
  });

  test("a NAMED callable interface ctor param lowers to a PLAIN token, not a factory (opt-out)", () => {
    const wiring = project.emitted("sample/wiring.js");
    // ThunkConsumer(thunk: IThunk) — IThunk is `interface IThunk { (): string }`.
    // It must be a string-token slot, never `{ factory: ... }`.
    expect(wiring).toContain(
      'defineDeps(ThunkConsumer, [["./sample/contracts/IThunk"]]);',
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

    // The unregistered `table` ctor param landed as a hole (undefined on a direct
    // resolve — there is no caller).
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

// ── Coverage 3: factory e2e (bare + partitioned + named-callable opt-out) ─────

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
      makeReport: (ctx: unknown) => unknown;
    }>(T.reportService);

    // The bare factory (hole-free target) routes through the normal resolve
    // path: a request-scoped target yields the SAME instance within one request.
    const a = reportService.makeCtx();
    const b = reportService.makeCtx();
    expect(a).toBe(b);
    expect(req.resolve<{ id: number }>(T.ctx)).toBe(a);
  });

  test("a partitioned `(ctx) => IReport` factory fills the hole positionally; fresh per call", async () => {
    const app = await project.load("sample/app.js");
    const rootScope = app.rootScope as () => {
      createScope: (n: string) => { resolve: <T>(t: string) => T };
    };
    const T = app.T as Record<string, string>;

    const req = rootScope().createScope("request");
    const reportService = req.resolve(T.reportService) as {
      makeReport: (ctx: { id: number }) => {
        repo: { db: unknown };
        ctx: { id: number } | undefined;
      };
    };

    const myCtx = { id: 99 };
    const report1 = reportService.makeReport(myCtx);
    const report2 = reportService.makeReport(myCtx);

    // The registered repo dep is resolved; the unregistered IRequestContext hole
    // is filled positionally by the caller-supplied arg.
    expect(report1.ctx).toBe(myCtx);
    expect(report1.repo).toBeDefined();
    // A parameterized factory bypasses the cache: fresh instance per call.
    expect(report1).not.toBe(report2);
  });
});
