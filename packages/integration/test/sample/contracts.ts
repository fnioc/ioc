// Interface-first contracts for the integration sample. These are app-internal
// types (not exported through the package's public surface), so the transformer
// derives package-qualified tokens of the form
// `fnioc-integration-sample/src/sample/contracts:IFoo`.

export interface ILogger {
  log(line: string): void;
  readonly lines: string[];
}

export interface IDbConnection {
  query(sql: string): string;
}

export interface IUserRepo {
  readonly db: IDbConnection;
  readonly logger: ILogger;
  find(id: number): string;
}

/** Resolved asynchronously — registered via a `Promise<IConfig>`-returning factory. */
export interface IConfig {
  readonly endpoint: string;
}

/** A request-scoped unit of work. */
export interface IRequestContext {
  readonly id: number;
}

/**
 * Built by a factory — holds a resolved repo dep. Intentionally simple:
 * no optional / caller-supplied params. The `resolveFactory` pattern for
 * parameterized construction is demonstrated in parity.test.ts directly.
 */
export interface IReport {
  readonly repo: IUserRepo;
}

/**
 * Holds one factory param — a bare zero-arg factory. The formerly partitioned
 * `makeReport` was removed: parameterized factory injection (`(params) => T`)
 * is now expressed via `scope.resolveFactory(token, params)` rather than inline
 * factory types. The makeReport capability is demonstrated in parity.test.ts
 * via the resolveFactory tests.
 */
export interface IReportService {
  readonly makeCtx: () => IRequestContext;
}

/**
 * A NAMED callable interface. Even though it is call-signature-shaped, a class
 * registered under it is a normal service, and a ctor param typed `IThunk` (NOT
 * an inline `() => IFoo`) lowers to a plain string token — the factory-detection
 * opt-out.
 */
export interface IThunk {
  (): string;
}

/** Depends on `IThunk` as a normal resolved service (proves the opt-out). */
export interface IThunkConsumer {
  readonly thunk: IThunk;
}

/** Declares the async config dep as `Promise<IConfig>`. */
export interface IConfigConsumer {
  readonly config: Promise<IConfig>;
}

/**
 * A service that holds a parameterized factory: `makeReport(log: ILogger) => IReport`.
 * The declared `log` param means the transformer emits `params: [ILogger token]`
 * on the FactoryRef, enabling caller-supplied override of the registered ILogger.
 * This is the integration sample for the declared-factory-args feature.
 */
export interface IReportFactory {
  readonly makeReport: (log: ILogger) => IReport;
}
