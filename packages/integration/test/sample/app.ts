// The sample entry point — drives resolution against the engine. Imported AFTER
// the transformer has lowered `wiring.ts`, so when this runs `services` holds
// string-token registrations carrying their dep signatures inline. Exercises the
// full graph: a singleton chain, a request-scoped
// repo, a bare zero-arg factory param, the named-callable opt-out, and the
// async-config value path.

import type { ServiceProvider } from "@fnioc/di";
import {
  services,
  CONFIG_TOKEN,
  THUNK_TOKEN,
  resetConfigFactoryRuns,
  type SampleScopes,
} from "./wiring.js";
import type { IConfig } from "./contracts.js";
import type {
  ConsoleLogger,
  SqlDb,
  SqlUserRepo,
  RequestContext,
  ReportService,
  ThunkConsumer,
  ConfigConsumer,
} from "./services.js";

const T = {
  logger: "fnioc-integration-sample/src/sample/contracts:ILogger",
  db: "fnioc-integration-sample/src/sample/contracts:IDbConnection",
  repo: "fnioc-integration-sample/src/sample/contracts:IUserRepo",
  ctx: "fnioc-integration-sample/src/sample/contracts:IRequestContext",
  report: "fnioc-integration-sample/src/sample/contracts:IReport",
  reportService: "fnioc-integration-sample/src/sample/contracts:IReportService",
  thunkConsumer: "fnioc-integration-sample/src/sample/contracts:IThunkConsumer",
  configConsumer: "fnioc-integration-sample/src/sample/contracts:IConfigConsumer",
  config: CONFIG_TOKEN,
  thunk: THUNK_TOKEN,
} as const;

export { T, resetConfigFactoryRuns };

/**
 * Opens the top-level "singleton" scope from the transformer-lowered
 * registrations. `build()` is frameless (no root); opening the "singleton" frame
 * here is what lets singleton-tagged registrations cache for the app's lifetime.
 */
export function rootScope(): ServiceProvider<SampleScopes> {
  return services.build().createScope("singleton");
}

export interface ResolvedGraph {
  readonly logger: ConsoleLogger;
  readonly db: SqlDb;
  readonly repo: SqlUserRepo;
  readonly ctx: RequestContext;
  readonly thunkConsumer: ThunkConsumer;
  readonly reportService: ReportService;
  readonly configConsumer: ConfigConsumer;
}

/**
 * Resolves the representative graph against a fresh root+request scope pair and
 * returns the live instances so a test can assert wiring + scoping.
 */
export function resolveGraph(): {
  root: ServiceProvider<SampleScopes>;
  req: ServiceProvider<SampleScopes>;
  resolved: ResolvedGraph;
} {
  const root = rootScope();
  const req = root.createScope("request");
  const resolved: ResolvedGraph = {
    logger: root.resolve(T.logger),
    db: root.resolve(T.db),
    repo: req.resolve(T.repo),
    ctx: req.resolve(T.ctx),
    thunkConsumer: root.resolve(T.thunkConsumer),
    reportService: req.resolve(T.reportService),
    configConsumer: root.resolve(T.configConsumer),
  };
  return { root, req, resolved };
}

export type { IConfig };
