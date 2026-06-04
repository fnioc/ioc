// Concrete services for the integration sample, authored interface-first. Their
// constructor deps are extracted by the transformer (or hand-fed in the
// plugin-less parity test). Static `built` counters let tests assert lifetime
// behaviour (one construction for a singleton; fresh for transient / request).

import type {
  IConfig,
  IDbConnection,
  ILogger,
  IReport,
  IReportFactory,
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

/**
 * Ctor deps: a logger + a db (both registered) + an optional `table?: string`.
 * Optionality is unified on union: `table?: string` lowers to a single slot
 * `union("string", { value: undefined })`. The `"string"` token wins when
 * registered; nothing registers it here, so the always-satisfiable LiteralRef
 * fallback supplies `undefined` and `table` stays `undefined`. This demonstrates
 * the optional-primitive union fallback end-to-end — an unregistered primitive
 * token degrades to `undefined` rather than erroring.
 */
export class SqlUserRepo implements IUserRepo {
  public static built = 0;
  public constructor(
    public readonly logger: ILogger,
    public readonly db: IDbConnection,
    public readonly table?: string,
  ) {
    SqlUserRepo.built += 1;
  }
  public find(id: number): string {
    this.logger.log(`find ${id}`);
    const from = this.table ?? "users";
    return this.db.query(`SELECT * FROM ${from} WHERE id=${id}`);
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
 * A request-scoped value object. Holds a repo dep resolved from the container.
 * Used in the `resolveFactory` integration tests via the parity test's
 * self-contained classes.
 */
export class Report implements IReport {
  public static built = 0;
  public constructor(
    public readonly repo: IUserRepo,
  ) {
    Report.built += 1;
  }
}

/**
 * Holds one inline factory param:
 *   - `makeCtx: () => IRequestContext` — a BARE zero-arg factory: the target is
 *     request-scoped, so the injected callable routes through the normal resolve
 *     path and RESPECTS the lifetime (same instance within one request).
 *
 * The transformer detects the inline arrow type and emits a `{ type }` slot.
 */
export class ReportService implements IReportService {
  public constructor(
    public readonly makeCtx: () => IRequestContext,
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

/**
 * Holds a parameterized factory: `(log: ILogger) => IReport`.
 *
 * The declared `log` parameter means the transformer emits `params: [ILogger token]`
 * on the FactoryRef. At runtime the engine routes the caller-supplied ILogger into
 * the IReport ctor's ILogger slot — even when ILogger is registered — and builds a
 * fresh IReport per call. This proves the declared-factory-args → caller-wins path
 * end-to-end through the real transformer and di engine.
 */
export class ReportFactory implements IReportFactory {
  public constructor(
    public readonly makeReport: (log: ILogger) => IReport,
  ) {}
}
