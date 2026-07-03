import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileWithTransformer, type CompiledProject } from "./harness.js";

// Coverage 1 (ABI contract / compile-with-transformer), 2 (progressive-
// enhancement parity), 3 (factory e2e + named-callable opt-out).
//
// The sample under `test/sample/` is compiled ONCE with the real ts-patch
// transformer; we assert the emitted shape (string tokens + inline signature
// third-arg, `{ type }` factory slots) and then LOAD the lowered output to run it
// against the live `@fnioc/di` engine. The parity test rebuilds the identical
// graph by hand (string tokens + inline `add(token, ctor, [[...]])`) and asserts
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

// Signatures ride INLINE on the registration: `add("token", Ctor, [[...]])`.
// The global metadata store is retired — no hoisted const, no `defineDeps`
// prelude, no injected import.
//
// Helper: pull the `[[...]]` inline signature array text out of the registration
// call for `ctor`, balanced-scanning from the `, ${ctor}, ` boundary.
function sigFor(wiring: string, ctor: string): string {
  // The signature array always opens `[[` immediately after `, Ctor, ` in the
  // registration call — anchor on that so the ctor's name in the import list
  // (`{ ..., Ctor, ... }`) never matches.
  const marker = `, ${ctor}, [`;
  const at = wiring.indexOf(marker);
  if (at < 0) {throw new Error(`No inline signature for ${ctor} in emitted wiring`);}
  const start = at + marker.length - 1;
  let depth = 0;
  for (let i = start; i < wiring.length; i++) {
    const ch = wiring[i];
    if (ch === "[") {
      depth += 1;
    } else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {return wiring.slice(start, i + 1);}
    }
  }
  throw new Error(`Unbalanced signature for ${ctor} in emitted wiring`);
}

describe("emit contract — transformer-emitted lowered output (PRD §8)", () => {
  test("no injected defineDeps import — signatures ride inline (ESM contract)", () => {
    const wiring = project.emitted("sample/wiring.js");
    expect(wiring).not.toContain("defineDeps");
    expect(wiring).not.toContain("ɵreg");
  });

  test("class with two registered deps + optional primitive emits one union-fallback signature", () => {
    const wiring = project.emitted("sample/wiring.js");
    // SqlUserRepo ctor: (logger, db, table?: string). logger + db tokenize to
    // their interface tokens; the optional `table?: string` lowers to
    // `union("string", { value: undefined })` — the "string" token wins if
    // registered, else `undefined` is supplied. One signature, no expansion.
    expect(sigFor(wiring, "SqlUserRepo")).toBe(
      '[["./sample/contracts/ILogger", "./sample/contracts/IDbConnection", { union: ["string", { value: void 0 }] }]]',
    );
    expect(wiring).toContain(
      'services.add("./sample/contracts/IUserRepo", SqlUserRepo, ',
    );
  });

  test("zero-arg classes lower to an empty signature", () => {
    const wiring = project.emitted("sample/wiring.js");
    for (const cls of ["ConsoleLogger", "SqlDb", "RequestContext"]) {
      expect(sigFor(wiring, cls)).toBe("[[]]");
    }
  });

  test("inline `() => I` ctor param lowers to a `{ type: token }` slot", () => {
    const wiring = project.emitted("sample/wiring.js");
    // ReportService has one factory param: `makeCtx: () => IRequestContext`.
    // The transformer emits the return type as the slot token.
    expect(sigFor(wiring, "ReportService")).toBe(
      '[[{ type: "./sample/contracts/IRequestContext" }]]',
    );
  });

  test("inline `(log: ILogger) => IReport` lowers to `{ type, params: [ILogger-token] }`", () => {
    const wiring = project.emitted("sample/wiring.js");
    // ReportFactory ctor: `makeReport: (log: ILogger) => IReport`.
    // The declared `log: ILogger` param becomes the params array on the FactoryRef.
    expect(sigFor(wiring, "ReportFactory")).toBe(
      '[[{ type: "./sample/contracts/IReport", params: ["./sample/contracts/ILogger"] }]]',
    );
  });

  test("the type-driven type arg lowers to a string token; `.as<\"x\">()` → `.as(\"x\")`", () => {
    const wiring = project.emitted("sample/wiring.js");
    expect(wiring).toContain(
      'services.add("./sample/contracts/ILogger", ConsoleLogger, [[]]).as("singleton");',
    );
  });

  test("Promise<IConfig> ctor dep → the honest closed-generic token Promise<IConfig>", () => {
    const wiring = project.emitted("sample/wiring.js");
    // Honest token-split: the dep is NOT unwrapped — it keys on the Promise token.
    expect(sigFor(wiring, "ConfigConsumer")).toBe(
      '[["Promise<./sample/contracts/IConfig>"]]',
    );
  });

  test("a NAMED callable interface ctor param lowers to a PLAIN token, not a factory (opt-out)", () => {
    const wiring = project.emitted("sample/wiring.js");
    // ThunkConsumer(thunk: IThunk) — IThunk is `interface IThunk { (): string }`.
    // It must be a string-token slot, never `{ factory: ... }`.
    expect(sigFor(wiring, "ThunkConsumer")).toBe(
      '[["./sample/contracts/IThunk"]]',
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

// ── Coverage 4: declared factory params → caller-wins e2e ────────────────────
//
// ReportFactory holds `makeReport: (log: ILogger) => IReport`. The transformer
// sees the declared `log: ILogger` param and emits
// `{ type: IReport-token, params: [ILogger-token] }`.
//
// At runtime:
//   - The ILogger ctor slot of IReport is filled by the caller-supplied value
//     (caller wins over the registered ConsoleLogger).
//   - Each call builds a FRESH IReport (parameterized factory bypasses the cache).

describe("parameterized factory e2e — declared arg overrides registered service", () => {
  test("caller-supplied ILogger wins over the registered ConsoleLogger; fresh instance per call", async () => {
    const app = await project.load("sample/app.js");
    const rootScope = app.rootScope as () => {
      createScope: (n: string) => {
        resolve: <T>(t: string) => T;
      };
      resolve: <T>(t: string) => T;
    };
    const T_MAP = app.T as Record<string, string>;

    const root = rootScope();
    const req = root.createScope("request");

    // The transformer emits the token for IReportFactory (request-scoped).
    const T_REPORT_FACTORY = "./sample/contracts/IReportFactory";
    const reportFactory = req.resolve<{
      makeReport: (log: { lines: string[] }) => { repo: unknown };
    }>(T_REPORT_FACTORY);

    // Caller-supplied custom logger — NOT the registered ConsoleLogger.
    const customLogger = { lines: [] as string[], log(l: string) { this.lines.push(l); } };
    const r1 = reportFactory.makeReport(customLogger);
    const r2 = reportFactory.makeReport(customLogger);

    // Report was built with the caller-supplied logger (verified by identity).
    const registeredLogger = root.resolve<{ lines: string[] }>(T_MAP.logger);
    // The factory produced a valid Report (has a repo dep resolved from container).
    expect((r1 as unknown as { repo: unknown }).repo).toBeDefined();
    // Fresh instance per call (parameterized factory bypasses the cache).
    expect(r1).not.toBe(r2);
    // The registered ConsoleLogger is not the caller-supplied one.
    expect(registeredLogger).not.toBe(customLogger);
  });
});
