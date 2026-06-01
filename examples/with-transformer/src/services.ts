// Concrete services for the example app. Constructor dependencies are extracted
// automatically by @fnioc/transformer: a `logger: ILogger` parameter lowers to
// the `./contracts/ILogger` token, so no metadata is hand-written here. Static
// `built` counters let the program prove singleton sharing at runtime.

import type { IClock, IGreeter, ILogger, IRequestId } from "./contracts.js";

export class ConsoleLogger implements ILogger {
  public static built = 0;
  private readonly buffer: string[] = [];
  public constructor() {
    ConsoleLogger.built += 1;
  }
  public get lines(): readonly string[] {
    return this.buffer;
  }
  public log(line: string): void {
    this.buffer.push(line);
  }
}

export class SystemClock implements IClock {
  public static built = 0;
  public constructor() {
    SystemClock.built += 1;
  }
  // A fixed value keeps the program's stdout deterministic for the test gate.
  public now(): string {
    return "2026-01-01T00:00:00Z";
  }
}

/** Depends on a logger + a clock; both lower to string tokens automatically. */
export class Greeter implements IGreeter {
  public static built = 0;
  public constructor(
    private readonly logger: ILogger,
    private readonly clock: IClock,
  ) {
    Greeter.built += 1;
  }
  public greet(name: string): string {
    const line = `[${this.clock.now()}] Hello, ${name}!`;
    this.logger.log(line);
    return line;
  }
}

/** Request-scoped: each `request` child scope owns its own id. */
export class RequestId implements IRequestId {
  public static built = 0;
  public readonly value: number;
  public constructor() {
    RequestId.built += 1;
    this.value = RequestId.built;
  }
}
