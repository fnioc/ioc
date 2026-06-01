// The same interface-first contracts as the with-transformer example. Identical
// app — the ONLY difference between the two examples is the wiring style, so the
// contrast is purely transformer vs. hand-written registration + metadata.

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
