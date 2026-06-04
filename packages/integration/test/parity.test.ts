import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ServiceManifest, forCtor, union, NoSatisfiableSignatureError } from "@fnioc/di";
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
  ReportFactory,
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
  reportFactory: "./sample/contracts/IReportFactory",
  thunkConsumer: "./sample/contracts/IThunkConsumer",
  configConsumer: "./sample/contracts/IConfigConsumer",
  config: "./sample/contracts/IConfig",
  thunk: "./sample/contracts/IThunk",
} as const;

let handFedConfigRuns = 0;
const theThunk = () => "thunk-result";

/** Build the identical graph WITHOUT the transformer — the plugin-less path. */
function buildHandFed(): ServiceManifest<"singleton" | "request"> {
  handFedConfigRuns = 0;

  // Path 2: hand-feed each class's ctor signature (forCtor / signature). These
  // arrays are exactly what the transformer's defineDeps emits.
  forCtor(SqlUserRepo).signature(T.logger, T.db);
  forCtor(Report).signature(T.repo);
  forCtor(ConfigConsumer).signature(T.config);
  forCtor(ThunkConsumer).signature(T.thunk);
  // ReportService's one inline factory param → FactoryRef slot, by hand:
  // a bare `() => IRequestContext`.
  forCtor(ReportService).signature({ type: T.ctx });
  // ReportFactory's parameterized factory: `(log: ILogger) => IReport`.
  // The transformer emits `{ type: IReport-token, params: [ILogger-token] }`.
  forCtor(ReportFactory).signature({ type: T.report, params: [T.logger] });

  const services = new ServiceManifest<"singleton" | "request">();
  services.add(T.logger, ConsoleLogger).as("singleton");
  services.add(T.db, SqlDb).as("singleton");
  services.add(T.repo, SqlUserRepo).as("request");
  services.add(T.ctx, RequestContext).as("request");
  services.add(T.report, Report).as("request");
  services.add(T.reportService, ReportService).as("request");
  services.add(T.reportFactory, ReportFactory).as("request");
  services.add(T.thunkConsumer, ThunkConsumer).as("singleton");
  services.add(T.configConsumer, ConfigConsumer).as("singleton");

  // Path 1: plugin-less registrations for the async config + the named-callable.
  // addFactory (no defineDeps record) → engine calls factory(scope); factory
  // ignores the scope arg and returns the Promise directly.
  services.addFactory(T.config, () => {
    handFedConfigRuns += 1;
    return Promise.resolve({ endpoint: "https://db.example/api" });
  }).as("singleton");
  services.addValue(T.thunk, theThunk);

  return services;
}

describe("progressive-enhancement parity — hand-fed graph (no transformer)", () => {
  test("the hand-fed graph resolves the same wiring + scoping as the compiled one", () => {
    const services = buildHandFed();
    const root = services.build().createScope("singleton");
    const reqA = root.createScope("request");
    const reqB = root.createScope("request");

    // Singleton chain: repo holds the singleton-frame-owned logger + db.
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

  test("bare factory respects lifetime: same request-scoped instance within one request", () => {
    const services = buildHandFed();
    const req = services.build().createScope("request");
    const rs = req.resolve<{
      makeCtx: () => unknown;
    }>(T.reportService);

    // Bare zero-arg factory routes through the normal resolve path: a
    // request-scoped target yields the SAME instance within one request.
    expect(rs.makeCtx()).toBe(rs.makeCtx());
    expect(rs.makeCtx()).toBe(req.resolve(T.ctx));
  });

  test("async config parity: singleton caches the Promise; factory runs once", async () => {
    const services = buildHandFed();
    const root = services.build().createScope("singleton");

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

// ── Union slot coverage ────────────────────────────────────────────────────────
//
// These tests exercise the `Union` / `union(...)` slot kind directly via the
// manual token surface, verifying the runtime semantics of §4 in the design:
//   - fallthrough: first member absent → tries second
//   - precedence: both members present → first wins
//   - exhaustion: no member present → throws NoSatisfiableUnionError
//
// They also verify the named-alias path (§8): a named type alias resolves under
// a single token, NOT as alternatives.

describe("Union slot — inline-union semantics (manual token surface)", () => {
  // Minimal service pair with compatible interfaces.
  class ServiceA { public readonly tag = "A"; }
  class ServiceB { public readonly tag = "B"; }
  class Consumer {
    public constructor(public readonly dep: { tag: string }) {}
  }

  const TA = "parity:ServiceA";
  const TB = "parity:ServiceB";
  const TConsumer = "parity:Consumer";

  test("fallthrough: only second member registered → resolves to second", () => {
    forCtor(Consumer).signature(union(TA, TB));
    const builder = new ServiceManifest();
    builder.add(TB, ServiceB);
    builder.add(TConsumer, Consumer);
    const root = builder.build();
    const consumer = root.resolve<Consumer>(TConsumer);
    expect(consumer.dep.tag).toBe("B");
  });

  test("precedence: both members registered → resolves to first (declaration order)", () => {
    forCtor(Consumer).signature(union(TA, TB));
    const builder = new ServiceManifest();
    builder.add(TA, ServiceA);
    builder.add(TB, ServiceB);
    builder.add(TConsumer, Consumer);
    const root = builder.build();
    const consumer = root.resolve<Consumer>(TConsumer);
    expect(consumer.dep.tag).toBe("A");
  });

  test("exhaustion: no member registered → throws (signature-level; union is entirely unresolvable)", () => {
    // When ALL union members are unregistered, selectSignature marks the entire
    // signature as unsatisfiable and throws NoSatisfiableSignatureError before
    // the union is ever resolved. NoSatisfiableUnionError fires from resolveUnion
    // only when the union was selected (at least one member appeared resolvable)
    // but then all members failed during the resolution phase — a scenario that
    // can arise if a member's own deps are unresolvable. For a pure "no-members-
    // registered" case the error is at the signature-selection level.
    forCtor(Consumer).signature(union(TA, TB));
    const builder = new ServiceManifest();
    builder.add(TConsumer, Consumer);
    const root = builder.build();
    expect(() => root.resolve(TConsumer)).toThrow(NoSatisfiableSignatureError);
  });

  // NOTE: NoSatisfiableUnionError is a safety-net in resolveUnion that fires when
  // NO member is resolvable during the resolution phase. In practice, selectSignature
  // already checked satisfiability — if it selected the signature, at least one
  // member IS resolvable. And resolveUnion does NOT catch errors from member
  // construction (it doesn't try-catch and fallthrough). So NoSatisfiableUnionError
  // cannot be triggered through the current di implementation's normal paths.
  // The exhaustion case (ALL members unregistered) throws NoSatisfiableSignatureError
  // at the signature-selection level before resolveUnion is ever entered.
});

describe("Named alias — single-token semantics (manual token surface)", () => {
  // A union alias resolves under its OWN token; registering the members
  // separately does nothing for a param typed via the alias.
  class ServiceA { public readonly tag = "A"; }
  class ServiceB { public readonly tag = "B"; }
  class ServiceAB { public readonly tag = "AB"; }
  class Consumer {
    public constructor(public readonly dep: { tag: string }) {}
  }

  const TA = "parity:named:ServiceA";
  const TB = "parity:named:ServiceB";
  // The alias token — the single registration target for the named alias.
  const TAB = "parity:named:ServiceAB";
  const TConsumer = "parity:named:Consumer";

  test("named alias resolves under its own single token, not member alternatives", () => {
    // Signature uses a single string token (the alias), NOT a union slot.
    forCtor(Consumer).signature(TAB);
    const builder = new ServiceManifest();
    builder.add(TA, ServiceA);     // registering A does nothing for Consumer
    builder.add(TB, ServiceB);     // registering B does nothing for Consumer
    builder.add(TAB, ServiceAB);   // this is the only one that matters
    builder.add(TConsumer, Consumer);
    const root = builder.build();
    const consumer = root.resolve<Consumer>(TConsumer);
    expect(consumer.dep.tag).toBe("AB");
  });

  test("named alias: only A+B registered (not AB) → throws (unregistered single token)", () => {
    forCtor(Consumer).signature(TAB);
    const builder = new ServiceManifest();
    builder.add(TA, ServiceA);
    builder.add(TB, ServiceB);
    builder.add(TConsumer, Consumer);
    const root = builder.build();
    expect(() => root.resolve(TConsumer)).toThrow();
  });
});

describe("Inject brand override — branded token wins (parity matrix §9)", () => {
  // Demonstrates that `forCtor(C).signature("my:token", ...)` is the exact
  // manual-surface equivalent of the transformer's `Inject<T, "my:token">` brand
  // on a ctor param: the branded token is used, not the structural derivation.
  class SpecialCache { public readonly kind = "special"; }
  class Handler {
    public constructor(public readonly cache: { kind: string }) {}
  }

  const BRANDED_TOKEN = "parity:inject:special-cache";
  const THandler = "parity:inject:Handler";

  test("branded token used in signature resolves against its own registration", () => {
    // The manual-surface equivalent of `Inject<ICache, "parity:inject:special-cache">`.
    forCtor(Handler).signature(BRANDED_TOKEN);
    const builder = new ServiceManifest();
    builder.add(BRANDED_TOKEN, SpecialCache);
    builder.add(THandler, Handler);
    const root = builder.build();
    const handler = root.resolve<Handler>(THandler);
    expect(handler.cache.kind).toBe("special");
  });
});

describe("resolveFactory — mixed registered + caller-supplied params (§2)", () => {
  // Demonstrates resolveFactory(type, params) with a mix of:
  //   - registered slots: resolved from the container
  //   - caller-supplied slots: named in params, filled positionally by the caller
  // A registered slot NAMED in params is an override (caller wins).
  class Logger { public readonly id = "logger"; }
  class Product {
    public constructor(
      public readonly logger: Logger,
      public readonly label: string,
    ) {}
  }

  const TLogger = "parity:rf:Logger";
  const TLabel = "parity:rf:label";
  const TProduct = "parity:rf:Product";

  test("mixed: registered Logger resolved from container; unregistered label is caller-supplied", () => {
    forCtor(Product).signature(TLogger, TLabel);
    const builder = new ServiceManifest();
    builder.add(TLogger, Logger);
    builder.add(TProduct, Product);
    const root = builder.build();

    // params = [TLabel] → TLabel is caller-supplied; TLogger comes from the container.
    const factory = root.resolveFactory(TProduct, [TLabel]) as (label: string) => Product;
    const p = factory("hello");
    expect(p.logger.id).toBe("logger");
    expect(p.label).toBe("hello");
  });

  test("strict zero-arg (no params): all slots registered → () => T works", () => {
    class ZeroArgProduct {
      public constructor(public readonly logger: Logger) {}
    }
    const TZeroArgProduct = "parity:rf:ZeroArgProduct";
    forCtor(ZeroArgProduct).signature(TLogger);
    const builder = new ServiceManifest();
    builder.add(TLogger, Logger);
    builder.add(TZeroArgProduct, ZeroArgProduct);
    const root = builder.build();

    // No params → strict zero-arg factory; every slot resolved from container.
    const factory = root.resolveFactory(TZeroArgProduct) as () => ZeroArgProduct;
    const p = factory();
    expect(p.logger.id).toBe("logger");
  });

  test("caller override of a registered slot (params wins over container)", () => {
    // TLogger IS registered, but we name it in params → caller wins.
    forCtor(Product).signature(TLogger, TLabel);
    const builder = new ServiceManifest();
    builder.add(TLogger, Logger);
    builder.add(TProduct, Product);
    const root = builder.build();

    // Naming both TLogger and TLabel in params: TLogger override wins over container.
    const factory = root.resolveFactory(TProduct, [TLogger, TLabel]) as (
      logger: Logger,
      label: string,
    ) => Product;
    const callerLogger = new Logger();
    const p = factory(callerLogger, "world");
    // The caller-supplied logger instance is used, not the container's.
    expect(p.logger).toBe(callerLogger);
    expect(p.label).toBe("world");
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
