// The SINGLE canonical set of service classes for BOTH example apps. These
// classes carry no knowledge of how they are wired: the with-transformer example
// derives their dependency metadata from the constructor types at build time,
// while the without-transformer example hand-writes the same metadata. Neither
// difference lives here — only in each example's main.ts.
//
// The two open-generic authoring brands are imported from `@fnioc/di`, the
// single public gateway to the ABI (core is private/source-only):
//   - `Typeof<T>` — the `typeof(T)` witness: a ctor param of this type receives
//     the TOKEN STRING of the erased type argument `T`.
//   - `Inject<T, K>` — pins a specific token for one ctor param.
import type { Inject, Typeof } from "@fnioc/di";
import type {
  IAuditor,
  IClock,
  IDiagnosticsService,
  IGreeter,
  ILogger,
  IMetricsBackend,
  IRepository,
  IRequestId,
} from "./contracts.js";

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

/** Depends on a logger + a clock. */
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

/** A metrics backend that records event keys. Used in the union demonstration. */
export class InMemoryMetrics implements IMetricsBackend {
  public readonly records: string[] = [];
  public record(key: string): void {
    this.records.push(key);
  }
}

/**
 * Inline-union ctor parameter: `sink: ILogger | IMetricsBackend` becomes a union
 * slot whose first resolvable member wins. ILogger is registered, so it wins.
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
 * The `Inject<T, "tok">` brand pins a specific token for the `clock` param,
 * overriding the token that would otherwise be derived structurally. The
 * with-transformer example emits `"app:primary-clock"` for that slot
 * automatically; the without-transformer example hand-writes the same token.
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

// ── Open-generics services ─────────────────────────────────────────────────────

/**
 * The open-generic implementation: ONE erased class behind every closing of
 * `IRepository<T>`. The `Typeof<T>` param is the `typeof(T)` witness — at each
 * closing it receives the type argument's TOKEN STRING, so the erased class
 * knows which entity it serves at runtime.
 */
export class SqlRepository<T> implements IRepository<T> {
  public static built = 0;
  public readonly kind = "sql";
  public constructor(
    private readonly logger: ILogger,
    public readonly entityToken: Typeof<T>,
  ) {
    SqlRepository.built += 1;
  }
  public save(_entity: T): string {
    const line = `[sql] saved ${this.entityToken}`;
    this.logger.log(line);
    return line;
  }
}

/**
 * A second generic impl — registered CLOSED for one entity, where an exact
 * (closed) registration always beats the open fallback for its closing.
 */
export class InMemoryRepository<T> implements IRepository<T> {
  public static built = 0;
  public readonly kind = "memory";
  readonly #items: T[] = [];
  public constructor(public readonly entityToken: Typeof<T>) {
    InMemoryRepository.built += 1;
  }
  public save(entity: T): string {
    this.#items.push(entity);
    return `[memory] saved ${this.entityToken} (count ${this.#items.length})`;
  }
}

/**
 * A generic service DEPENDING on a generic: `IRepository<T>`. It closes
 * recursively — resolving `IAuditor<User>` wires in the `IRepository<User>`
 * closing of the repository above (the same instance, per-closing cached).
 */
export class RepositoryAuditor<T> implements IAuditor<T> {
  public constructor(public readonly repo: IRepository<T>) {}
  public audit(): string {
    return `auditing ${this.repo.entityToken}`;
  }
}
