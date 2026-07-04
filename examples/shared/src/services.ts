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
  IAppConfig,
  IAsyncResource,
  IAuditor,
  IClock,
  IDiagnosticsService,
  IFeatureToggle,
  IGreeter,
  ILogger,
  IMetricsBackend,
  IOperationId,
  IPersonalizedGreeting,
  IReleaseChannel,
  IRemoteConfig,
  IRemoteConfigConsumer,
  IReporter,
  IRepository,
  IRequestId,
  ISyncResource,
  IWelcomeBanner,
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

/**
 * A second `IClock` implementation, existing ONLY to demonstrate LAST-WINS
 * override: registering `IClock` a second time (this class, registered after
 * `SystemClock`) makes every subsequent `IClock` resolution return THIS
 * instance instead. The engine keeps every prior registration in its list — an
 * override never deletes anything — but always resolves the MOST RECENT entry.
 */
export class OverrideClock implements IClock {
  public static built = 0;
  public constructor() {
    OverrideClock.built += 1;
  }
  public now(): string {
    return "2099-12-31T23:59:59Z";
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

// ── Factory + value registration ────────────────────────────────────────────────

/**
 * The factory function BOTH examples register identically — only the
 * REGISTRATION differs (with-transformer: tokenless `addFactory<IWelcomeBanner>`;
 * without-transformer: `addFactory("token", createWelcomeBanner, [[...]])`). Its
 * params are injected exactly like a ctor's — `logger` and `clock` are ordinary
 * resolved slots — so this function carries no more wiring knowledge than any
 * class above it; only the REGISTRATION CALL a factory needs differs from `add`.
 */
export function createWelcomeBanner(logger: ILogger, clock: IClock): IWelcomeBanner {
  const text = `Welcome! (as of ${clock.now()})`;
  logger.log(text);
  return { text };
}

/**
 * The canonical pre-built value both examples register via `addValue` — never
 * constructed by the container, so resolving it twice returns the identical
 * reference trivially: there is no construction step, and so no lifetime, to
 * observe.
 */
export const appConfig: IAppConfig = Object.freeze({
  environment: "demo",
  version: "1.0.0",
});

// ── Literal + optional deps ─────────────────────────────────────────────────────

/**
 * `channel`'s TYPE is the literal `"stable"`, not the widened `string` the
 * interface declares: a whole-type literal ctor parameter derives a
 * `LiteralRef` slot directly from the TYPE, so the engine injects the value
 * with no token and no registration — always satisfiable, exactly like
 * `SqlRepository`'s `Typeof<T>` witness is always satisfiable, just supplied
 * from a fixed literal instead of a closing's type argument.
 */
export class ReleaseChannel implements IReleaseChannel {
  public constructor(public readonly channel: "stable") {}
}

/**
 * Depends OPTIONALLY on `IFeatureToggle` — a contract this package never
 * implements or registers. Any optional ctor param (a `?` marker, a default
 * initializer, or an explicit `| undefined`) lowers to
 * `union(<token>, { value: undefined })`; with the token unregistered, the
 * always-satisfiable `LiteralRef` fallback supplies `undefined` instead of
 * throwing.
 */
export class OptionalConsumer {
  public constructor(public readonly toggle?: IFeatureToggle) {}
  public describe(): string {
    return this.toggle
      ? `toggle active: ${this.toggle.active}`
      : "no toggle registered (undefined fallback)";
  }
}

// ── Async-only (Promise<T>) registration ────────────────────────────────────────

/** Registered ONLY as `Promise<IRemoteConfig>` — see `fetchRemoteConfig`. */
export class RemoteConfig implements IRemoteConfig {
  public static built = 0;
  public constructor(public readonly endpoint: string) {
    RemoteConfig.built += 1;
  }
}

/**
 * Simulates an async remote fetch — the source of the `Promise<IRemoteConfig>`
 * registration. Both examples register this IDENTICAL function; only the
 * registration differs (see `IRemoteConfig`). Nothing ever registers bare
 * `IRemoteConfig` — only its Promise-wrapped form exists in the container.
 */
export async function fetchRemoteConfig(): Promise<IRemoteConfig> {
  return new RemoteConfig("https://api.example.test");
}

/**
 * Depends on the BARE `IRemoteConfig` in its constructor — never registered
 * directly. `resolveAsync<IRemoteConfigConsumer>()` succeeds by recursively
 * resolving `IRemoteConfig` via the honest `Promise<IRemoteConfig>` fallback
 * (satisfied by `fetchRemoteConfig`) and awaiting it before this constructor
 * ever runs — the headline async proof.
 */
export class RemoteConfigConsumer implements IRemoteConfigConsumer {
  public static built = 0;
  public constructor(private readonly config: IRemoteConfig) {
    RemoteConfigConsumer.built += 1;
  }
  public describe(): string {
    return `resolved via async fallback: endpoint=${this.config.endpoint}`;
  }
}

// ── Disposal ─────────────────────────────────────────────────────────────────────

/**
 * Native `Disposable` — logs its own teardown through the shared `ILogger` so
 * disposal ORDER (reverse of construction) is observable in `logger.lines`.
 */
export class SyncResource implements ISyncResource, Disposable {
  public static built = 0;
  public disposed = false;
  public constructor(private readonly logger: ILogger) {
    SyncResource.built += 1;
  }
  public [Symbol.dispose](): void {
    this.disposed = true;
    this.logger.log("disposed: sync-resource");
  }
}

/**
 * Native `AsyncDisposable` — logs its own teardown through the shared `ILogger`
 * so disposal ORDER (reverse of construction) is observable in `logger.lines`.
 */
export class AsyncResource implements IAsyncResource, AsyncDisposable {
  public static built = 0;
  public disposed = false;
  public constructor(private readonly logger: ILogger) {
    AsyncResource.built += 1;
  }
  public async [Symbol.asyncDispose](): Promise<void> {
    await Promise.resolve(); // simulated async teardown (flush, close, …)
    this.disposed = true;
    this.logger.log("disposed: async-resource");
  }
}

// ── Overload selection ────────────────────────────────────────────────────────────

/**
 * TWO constructor overloads. The resolver carries BOTH signatures on one
 * registration and greedily selects the FIRST whose slots are all registered,
 * tried longest-first: `(logger, metrics)` when `IMetricsBackend` is
 * registered for the slot, else it falls back to `(logger)`.
 *
 * Also the target of the overload-faithful `addFactory` wrapper: registering
 * `Reporter` AS a factory —
 * `addFactory<IReporter>((...args: OverloadedConstructorParameters<typeof
 * Reporter>) => Reflect.construct(Reporter, args))` — must resolve identically
 * to registering it directly with `add<IReporter>(Reporter)`. That equivalence
 * is the whole point of the overload-faithful parameter-tuple utilities: a
 * factory built from them carries every constructor overload, not just the
 * last one `ConstructorParameters` would see.
 */
export class Reporter implements IReporter {
  public static built = 0;
  public constructor(logger: ILogger, metrics: IMetricsBackend);
  public constructor(logger: ILogger);
  public constructor(
    public readonly logger: ILogger,
    public readonly metrics?: IMetricsBackend,
  ) {
    Reporter.built += 1;
  }
  public report(): string {
    return this.metrics ? "with-metrics" : "logger-only";
  }
}

// ── resolveFactory (parameterized form) ─────────────────────────────────────────

/**
 * One registered dep (`logger`) + one caller-supplied dep (`name` — nobody
 * registers a single global "name"). The natural target for `resolveFactory`'s
 * PARAMETERIZED form: a fresh instance every call, built from caller-supplied
 * args, bypassing whatever lifetime tag it carries (contrast the ZERO-ARG form,
 * which respects the target's registered lifetime — e.g. `Greeter`, already a
 * singleton above, resolved via `resolveFactory` with no params).
 */
export class PersonalizedGreeting implements IPersonalizedGreeting {
  public static built = 0;
  public constructor(
    private readonly logger: ILogger,
    public readonly name: string,
  ) {
    PersonalizedGreeting.built += 1;
    this.logger.log(`personalized greeting requested for ${name}`);
  }
  public get text(): string {
    return `Welcome, ${this.name}!`;
  }
}

// ── Additional scope tags ───────────────────────────────────────────────────────

/**
 * Scope-agnostic identity witness (construction-counted, like `RequestId`).
 * Registered under a THIRD scope tag (beyond singleton/request) it behaves
 * exactly like `RequestId` does for "request": stable within one open frame of
 * that tag, distinct across separate frames. The SAME registration, resolved
 * from a vantage point where that tag is NOT an open ancestor, is the
 * TRANSIENT witness instead — no matching frame ⇒ a fresh instance every
 * resolve, no cache, no error.
 */
export class OperationId implements IOperationId {
  public static built = 0;
  public readonly value: number;
  public constructor() {
    OperationId.built += 1;
    this.value = OperationId.built;
  }
}
