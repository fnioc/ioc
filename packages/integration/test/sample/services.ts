// Concrete services for the integration sample, authored interface-first. Their
// constructor deps are extracted by the transformer (or hand-fed in the
// plugin-less parity test). Static `built` counters let tests assert lifetime
// behaviour (one construction for a singleton; fresh for transient / request).

import type {
  IConfig,
  IDbConnection,
  ILogger,
  IReport,
  IReportService,
  IRequestContext,
  IThunk,
  IUserRepo,
} from "./contracts.js";

export class ConsoleLogger implements ILogger {
  public static built = 0;
  public readonly lines: string[] = [];
  public constructor() {
    ConsoleLogger.built += 1;
  }
  public log(line: string): void {
    this.lines.push(line);
  }
}

export class SqlDb implements IDbConnection {
  public static built = 0;
  public constructor() {
    SqlDb.built += 1;
  }
  public query(sql: string): string {
    return `result(${sql})`;
  }
}

/** Ctor deps: a logger + a db (both registered) + an unregistered table name (a hole). */
export class SqlUserRepo implements IUserRepo {
  public static built = 0;
  public constructor(
    public readonly logger: ILogger,
    public readonly db: IDbConnection,
    public readonly table: string,
  ) {
    SqlUserRepo.built += 1;
  }
  public find(id: number): string {
    this.logger.log(`find ${id}`);
    return this.db.query(`SELECT * FROM users WHERE id=${id}`);
  }
}

/** Request-scoped: each request scope owns its own context. */
export class RequestContext implements IRequestContext {
  public static built = 0;
  public readonly id: number;
  public constructor() {
    RequestContext.built += 1;
    this.id = RequestContext.built;
  }
}

/**
 * A factory target with a PARTITIONED / positional signature: a registered repo
 * dep plus an unregistered `IRequestContext`-shaped hole the caller supplies.
 * Built fresh per factory call.
 */
export class Report implements IReport {
  public static built = 0;
  public constructor(
    public readonly repo: IUserRepo,
    public readonly ctx: IRequestContext | undefined,
  ) {
    Report.built += 1;
  }
}

/**
 * Holds two factory params:
 *   - `makeCtx: () => IRequestContext` — a BARE factory: the target has no holes
 *     and is request-scoped, so the injected callable routes through the normal
 *     resolve path and RESPECTS the lifetime (same instance within one request).
 *   - `makeReport: (ctx) => IReport` — a PARTIAL factory: Report's ctor mixes a
 *     registered repo dep with an unregistered IRequestContext hole, so the
 *     factory's call signature exposes only the hole, filled positionally, and a
 *     FRESH instance is built per call.
 * The transformer detects both inline arrow types and emits `{ factory }` slots.
 */
export class ReportService implements IReportService {
  public constructor(
    public readonly makeCtx: () => IRequestContext,
    public readonly makeReport: (ctx: IRequestContext) => IReport,
  ) {}
}

/**
 * Depends on `IThunk` — a NAMED callable interface — as a normal (resolved)
 * service. The ctor param is typed `IThunk`, NOT an inline `() => IFoo`, so the
 * transformer emits a plain string token: di resolves the registered IThunk
 * value, never a factory callable. This is the factory-detection opt-out.
 */
export class ThunkConsumer {
  public constructor(public readonly thunk: IThunk) {}
}

/** Consumes the async config; declares the dep as `Promise<IConfig>`. */
export class ConfigConsumer {
  public constructor(public readonly config: Promise<IConfig>) {}
}
