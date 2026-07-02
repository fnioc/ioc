// The SINGLE canonical set of contracts for BOTH example apps. The two examples
// (with-transformer, without-transformer) import these identical interfaces and
// entities — the ONLY difference between the two is the WIRING in their
// respective main.ts. This file, and services.ts beside it, are the shared
// source; there is no per-example copy.

/** Collects log lines so the demo can prove a singleton logger is shared. */
export interface ILogger {
  log(line: string): void;
  readonly lines: readonly string[];
}

/** A clock the greeter reads the "current" time from. */
export interface IClock {
  now(): string;
}

/** Produces a greeting, logs it, and returns it. */
export interface IGreeter {
  greet(name: string): string;
}

/** A request-scoped identifier — one per `request` child scope. */
export interface IRequestId {
  readonly value: number;
}

/**
 * A secondary logging/metrics sink. Used in the inline-union demonstration:
 * a `sink: ILogger | IMetricsBackend` ctor param becomes a union slot — the
 * first registered interface wins (declaration order = precedence).
 */
export interface IMetricsBackend {
  record(key: string): void;
  readonly records: readonly string[];
}

/**
 * A diagnostics service. Its implementation pins a specific clock token with the
 * `Inject` brand — the with-transformer example derives that pin automatically,
 * the without-transformer example replicates it with a hand-written signature.
 */
export interface IDiagnosticsService {
  diagnose(): string;
}

// ── Open-generics contracts ────────────────────────────────────────────────────

/**
 * A generic repository. TypeScript generics are erased — ONE JS class serves
 * every closing — so each closing (`IRepository<User>`, `IRepository<Order>`)
 * gets its own cache identity in the container while sharing one implementation.
 */
export interface IRepository<T> {
  save(entity: T): string;
  /** The type argument's token — a runtime witness of the erased `T`. */
  readonly entityToken: string;
  readonly kind: string;
}

/** A generic service that DEPENDS on a generic — closes recursively per entity. */
export interface IAuditor<T> {
  audit(): string;
  readonly repo: IRepository<T>;
}

/** Demo entities — the type arguments the repositories are closed over. */
export class User {}
export class Invoice {}
export class Order {}
