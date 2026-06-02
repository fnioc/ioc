// Interface-first contracts for the example app. These are app-internal types,
// so the @fnioc/transformer derives source-relative tokens of the form
// `./contracts/ILogger` for each one — no string token is ever written by hand.

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

// ── Extra contracts for Inject and union demonstrations ───────────────────────

/**
 * A secondary logging/metrics sink. Used in the inline-union demonstration:
 * a `cache: ILogger | IMetricsBackend` ctor param becomes a union slot — the
 * first registered interface wins (declaration order = precedence).
 */
export interface IMetricsBackend {
  record(key: string): void;
  readonly records: readonly string[];
}

/**
 * A "third-party" diagnostics service — a class we cannot annotate with its
 * deps because we do not own the source. The Inject brand is used on one of its
 * parameters to pin a specific token, overriding the transformer's structural
 * derivation. The `forCtor`/registration override path (§6) is the alternative.
 */
export interface IDiagnosticsService {
  diagnose(): string;
}
