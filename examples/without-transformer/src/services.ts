// The same concrete services as the with-transformer example. Note these classes
// carry NO knowledge of how they are wired — the dependency metadata lives in
// main.ts (hand-written), exactly where the transformer would otherwise inject
// it. Static `built` counters let the program prove singleton sharing.

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

/** Depends on a logger + a clock. Its metadata is registered by hand in main.ts. */
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

// ── union and third-party demonstration classes ───────────────────────────────

/**
 * A "diagnostics reporter" that depends on any available log sink — either the
 * real logger or the clock (for simple timestamp-prefixed output). This class is
 * used to demonstrate a `union(...)` slot: its log dep resolves to whichever of
 * the two is available, in declaration order.
 */
export class DiagnosticsReporter {
  public static built = 0;
  public constructor(public readonly sink: { log?: (msg: string) => void; now?: () => string }) {
    DiagnosticsReporter.built += 1;
  }
  public report(msg: string): string {
    if (this.sink.log) {
      this.sink.log(`[diag] ${msg}`);
      return `logged: ${msg}`;
    }
    if (this.sink.now) {
      return `[${this.sink.now()}] ${msg}`;
    }
    return msg;
  }
}

/**
 * Simulates a third-party class whose constructor we cannot annotate. The wiring
 * must supply a complete manual `forCtor(ThirdPartyFormatter).signature(...)`
 * because the class has no transformer-emitted metadata and no `@signature`
 * decorator.
 */
export class ThirdPartyFormatter {
  public constructor(
    public readonly logger: ILogger,
    public readonly clock: IClock,
  ) {}
  public format(text: string): string {
    return `[${this.clock.now()}] ${text}`;
  }
}
