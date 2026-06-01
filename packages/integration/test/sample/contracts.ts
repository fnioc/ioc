// Interface-first contracts for the integration sample. These are app-internal
// types (not exported through a package's public surface), so the transformer
// derives source-relative tokens of the form `./sample/contracts/IFoo`.

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
 * Built by a factory parameter; carries a caller-supplied string request ID.
 * `requestId?: string` is a primitive → always a hole in the transformer output,
 * guaranteeing the factory's call signature is `(requestId: string) => IReport`.
 */
export interface IReport {
  readonly repo: IUserRepo;
  readonly requestId?: string;
}

/** Holds two factory params (a bare zero-arg factory and a partitioned factory). */
export interface IReportService {
  readonly makeCtx: () => IRequestContext;
  readonly makeReport: (requestId: string) => IReport;
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
