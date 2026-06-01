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
