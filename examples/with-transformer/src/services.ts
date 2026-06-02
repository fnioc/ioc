// Concrete services for the example app. Constructor dependencies are extracted
// automatically by @fnioc/transformer: a `logger: ILogger` parameter lowers to
// the `./contracts/ILogger` token, so no metadata is hand-written here. Static
// `built` counters let the program prove singleton sharing at runtime.

import type { Inject } from "./fnioc-transformer.js";
import type { IClock, IDiagnosticsService, IGreeter, ILogger, IMetricsBackend, IRequestId } from "./contracts.js";

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

// ── Extra services for Inject and union demonstrations ────────────────────────

/**
 * A simple metrics backend that records event keys.
 * Used in the inline-union demonstration.
 */
export class InMemoryMetrics implements IMetricsBackend {
  public readonly records: string[] = [];
  public record(key: string): void {
    this.records.push(key);
  }
}

/**
 * Demonstrates an inline-union ctor parameter: `sink: ILogger | IMetricsBackend`.
 * The transformer lowers this to a Union slot. Since ILogger is registered first
 * in the declaration (and registered in the container), it wins.
 */
export class UnionConsumer {
  public constructor(
    public readonly sink: ILogger | IMetricsBackend,
  ) {}
  public emit(msg: string): void {
    if ("log" in this.sink) {
      this.sink.log(`[union] ${msg}`);
    } else {
      this.sink.record(msg);
    }
  }
}

/**
 * Demonstrates the `Inject<T, "tok">` brand. The `clock` param is branded
 * `Inject<IClock, "app:primary-clock">`. The transformer emits the token
 * `"app:primary-clock"` for that slot instead of the structurally-derived
 * `./contracts/IClock`. This makes the class resolvable even when no service is
 * registered under `./contracts/IClock`, as long as one is registered under
 * `"app:primary-clock"`.
 */
export class DiagnosticsService implements IDiagnosticsService {
  public constructor(
    private readonly clock: Inject<IClock, "app:primary-clock">,
    private readonly logger: ILogger,
  ) {}
  public diagnose(): string {
    const msg = `diagnostics at ${this.clock.now()}`;
    this.logger.log(msg);
    return msg;
  }
}
