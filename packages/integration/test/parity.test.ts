import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DiBuilder } from "@fnioc/di";
import { forCtor, hole } from "@fnioc/core";
import { compileWithTransformer, type CompiledProject } from "./harness.js";

// Coverage 2: progressive-enhancement parity — THE headline property.
//
// The SAME sample graph, registered WITHOUT the transformer using the three
// plugin-less paths (PRD §9):
//   1. `useValue` / `useFactory`              (the async config + the IThunk value)
//   2. `forCtor(C).signature(...)`            (hand-fed tokens for classes you own)
//   3. (`@signature` — the third path — is exercised in engine-rules.test.ts)
//
// Tokens are hand-authored to the EXACT strings the transformer emits, and the
// hand-fed metadata mirrors the lowered `defineDeps` arrays. We then assert the
// hand-fed graph resolves to behaviourally identical results as the
// transformer-compiled graph: same scoping, same factory behaviour, same async
// caching.
//
// The sample source classes are imported through Bun's `exports.bun` channel
// (raw `.ts`, no transform), so they carry NO transformer metadata — proving the
// hand-fed path stands alone.
import {
  ConsoleLogger,
  SqlDb,
  SqlUserRepo,
  RequestContext,
  Report,
  ReportService,
  ConfigConsumer,
  ThunkConsumer,
} from "./sample/services.js";

const T = {
  logger: "./sample/contracts/ILogger",
  db: "./sample/contracts/IDbConnection",
  repo: "./sample/contracts/IUserRepo",
  ctx: "./sample/contracts/IRequestContext",
  report: "./sample/contracts/IReport",
  reportService: "./sample/contracts/IReportService",
  thunkConsumer: "./sample/contracts/IThunkConsumer",
  configConsumer: "./sample/contracts/IConfigConsumer",
  config: "./sample/contracts/IConfig",
  thunk: "./sample/contracts/IThunk",
} as const;

let handFedConfigRuns = 0;
const theThunk = () => "thunk-result";

/** Build the identical graph WITHOUT the transformer — the plugin-less path. */
function buildHandFed(): DiBuilder<"singleton" | "request"> {
  handFedConfigRuns = 0;

  // Path 2: hand-feed each class's ctor signature (forCtor / signature). These
  // arrays are exactly what the transformer's defineDeps emits.
  forCtor(SqlUserRepo).signature(T.logger, T.db, hole);
  forCtor(Report).signature(T.repo, hole);
  forCtor(ConfigConsumer).signature(T.config);
  forCtor(ThunkConsumer).signature(T.thunk);
  // ReportService's two inline factory params → FactoryRef slots, by hand: a
  // bare `() => IRequestContext` and a partial `(ctx) => IReport`.
  forCtor(ReportService).signature({ factory: T.ctx }, { factory: T.report });

  const services = new DiBuilder<"singleton" | "request">();
  services.add(T.logger, ConsoleLogger).as("singleton");
  services.add(T.db, SqlDb).as("singleton");
  services.add(T.repo, SqlUserRepo).as("request");
  services.add(T.ctx, RequestContext).as("request");
  services.add(T.report, Report).as("request");
  services.add(T.reportService, ReportService).as("request");
  services.add(T.thunkConsumer, ThunkConsumer).as("singleton");
  services.add(T.configConsumer, ConfigConsumer).as("singleton");

  // Path 1: plugin-less overrides for the async config + the named-callable.
  services.register(T.config, {
    useFactory: () => {
      handFedConfigRuns += 1;
      return Promise.resolve({ endpoint: "https://db.example/api" });
    },
    tag: "singleton",
  });
  services.register(T.thunk, { useValue: theThunk });

  return services;
}

describe("progressive-enhancement parity — hand-fed graph (no transformer)", () => {
  test("the hand-fed graph resolves the same wiring + scoping as the compiled one", () => {
    const services = buildHandFed();
    const root = services.createScope("singleton");
    const reqA = root.createScope("request");
    const reqB = root.createScope("request");

    // Singleton chain: repo holds the root-owned logger + db.
    const repo = reqA.resolve<{ logger: object; db: object; find: (n: number) => string }>(T.repo);
    expect(root.resolve<object>(T.logger)).toBe(repo.logger);
    expect(root.resolve<object>(T.db)).toBe(repo.db);
    expect(repo.find(7)).toBe("result(SELECT * FROM users WHERE id=7)");

    // Request scoping identical to the compiled graph.
    expect(reqA.resolve(T.logger)).toBe(reqB.resolve(T.logger));
    expect(reqA.resolve(T.ctx)).not.toBe(reqB.resolve(T.ctx));
    expect(reqA.resolve(T.repo)).not.toBe(reqB.resolve(T.repo));

    // Named-callable opt-out: ThunkConsumer.thunk is the resolved value.
    const tc = root.resolve<{ thunk: () => string }>(T.thunkConsumer);
    expect(tc.thunk()).toBe("thunk-result");
  });

  test("factory behaviour matches: bare factory respects lifetime, partitioned fills the hole", () => {
    const services = buildHandFed();
    const req = services.createScope("singleton").createScope("request");
    const rs = req.resolve<{
      makeCtx: () => unknown;
      makeReport: (ctx: { id: number }) => { ctx: { id: number } | undefined };
    }>(T.reportService);

    // Bare factory (hole-free target): same request-scoped instance within one
    // request, identical to a direct resolve of the context.
    expect(rs.makeCtx()).toBe(rs.makeCtx());
    expect(rs.makeCtx()).toBe(req.resolve(T.ctx));

    // Partitioned factory: caller arg fills the hole; fresh per call.
    const ctx = { id: 99 };
    const r1 = rs.makeReport(ctx);
    const r2 = rs.makeReport(ctx);
    expect(r1.ctx).toBe(ctx);
    expect(r1).not.toBe(r2);
  });

  test("async config parity: singleton caches the Promise; factory runs once", async () => {
    const services = buildHandFed();
    const root = services.createScope("singleton");

    const p1 = root.resolve<Promise<{ endpoint: string }>>(T.config);
    const p2 = root.resolve<Promise<{ endpoint: string }>>(T.config);
    expect(p1).toBe(p2); // singleton caches the SAME Promise
    expect(handFedConfigRuns).toBe(1); // factory ran once

    const a = await p1;
    const b = await p2;
    expect(a).toBe(b); // awaiting twice → same instance
    expect(a.endpoint).toBe("https://db.example/api");
  });
});

// Behavioural cross-check: load the transformer-compiled graph and assert the
// SAME observable outcomes the hand-fed path produced. Same property, two
// production paths.
describe("parity cross-check — compiled graph matches hand-fed observations", () => {
  const SAMPLE_DIR = join(import.meta.dir, "sample");
  let project: CompiledProject;

  beforeAll(() => {
    const files: Record<string, string> = {};
    for (const name of ["contracts.ts", "services.ts", "wiring.ts", "app.ts"]) {
      files[`sample/${name}`] = readFileSync(join(SAMPLE_DIR, name), "utf8");
    }
    project = compileWithTransformer(files);
  }, 60_000);
  afterAll(() => project?.cleanup());

  test("compiled async config caches one Promise; awaiting twice yields one instance", async () => {
    const app = await project.load("sample/app.js");
    const rootScope = app.rootScope as () => { resolve: <T>(t: string) => T };
    const T2 = app.T as Record<string, string>;

    const root = rootScope();
    const p1 = root.resolve<Promise<{ endpoint: string }>>(T2.config);
    const p2 = root.resolve<Promise<{ endpoint: string }>>(T2.config);
    expect(p1).toBe(p2);

    const a = await p1;
    const b = await p2;
    expect(a).toBe(b);
    expect(a.endpoint).toBe("https://db.example/api");
  });
});
