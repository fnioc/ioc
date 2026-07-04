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

// ── Factory + value registration ────────────────────────────────────────────────

/**
 * Built via a FACTORY (`addFactory`), not a class registration — see
 * `createWelcomeBanner`. A factory's params are injected exactly like a ctor's;
 * only the REGISTRATION call differs from a class (`addFactory` vs `add`).
 */
export interface IWelcomeBanner {
  readonly text: string;
}

/**
 * A pre-built value — registered via `addValue`, never constructed by the
 * container. No lifetime, no deps: resolving it twice returns the identical
 * reference trivially, because there is no construction step to observe.
 */
export interface IAppConfig {
  readonly environment: string;
  readonly version: string;
}

// ── Literal + optional deps ─────────────────────────────────────────────────────

/**
 * Depends on a LITERAL type (`"stable"`, not `string`): a whole-type literal
 * ctor parameter derives a `LiteralRef` slot straight from the TYPE, so the
 * engine injects the value directly — no token, no registration, always
 * satisfiable. See `ReleaseChannel`.
 */
export interface IReleaseChannel {
  readonly channel: string;
}

/**
 * A contract this package never implements or registers. Its only job is the
 * optional-dep demonstration: `OptionalConsumer`'s ctor param
 * `toggle?: IFeatureToggle` proves that ANY optional dependency form (`?`, a
 * default, or an explicit `| undefined`) that goes unregistered degrades to
 * `undefined` instead of throwing.
 */
export interface IFeatureToggle {
  readonly active: boolean;
}

// ── Async-only (Promise<T>) registration ────────────────────────────────────────

/**
 * Resolved ONLY asynchronously — registered as `Promise<IRemoteConfig>`, never
 * as bare `IRemoteConfig`. See `fetchRemoteConfig` (the async factory that
 * produces it) and `RemoteConfigConsumer` (whose constructor depends on the
 * BARE token, recursively satisfied through the honest `Promise<T>` fallback).
 */
export interface IRemoteConfig {
  readonly endpoint: string;
}

/**
 * Its constructor depends on the BARE `IRemoteConfig` — a token this package
 * never registers directly (only `Promise<IRemoteConfig>` is registered).
 * `resolveAsync<IRemoteConfigConsumer>()` succeeds by recursively resolving
 * `IRemoteConfig` via the honest `Promise<T>` fallback and awaiting it before
 * this constructor ever runs.
 */
export interface IRemoteConfigConsumer {
  describe(): string;
}

// ── Disposal ─────────────────────────────────────────────────────────────────────

/** Native `Symbol.dispose` teardown — see `SyncResource`. */
export interface ISyncResource {
  readonly disposed: boolean;
}

/** Native `Symbol.asyncDispose` teardown — see `AsyncResource`. */
export interface IAsyncResource {
  readonly disposed: boolean;
}

// ── Overload selection ────────────────────────────────────────────────────────────

/**
 * Backed by a class with MULTIPLE constructor overloads (see `Reporter`). The
 * resolver carries every ctor signature on one registration and greedily
 * selects the longest SATISFIABLE one, tried longest-first. `Reporter` is also
 * the target of the overload-faithful `addFactory` wrapper — registering it AS
 * a factory (`addFactory<IReporter>((...args: OverloadedConstructorParameters<
 * typeof Reporter>) => Reflect.construct(Reporter, args))`) must resolve
 * identically to registering it directly with `add<IReporter>(Reporter)`.
 */
export interface IReporter {
  report(): string;
}

// ── resolveFactory (parameterized form) ─────────────────────────────────────────

/**
 * Built via `resolveFactory` with a caller-supplied `name` (see
 * `PersonalizedGreeting`) — a fresh instance every call, even under a cached
 * lifetime tag: a PARAMETERIZED factory always bypasses the instance cache,
 * unlike the zero-arg form (which respects the target's registered lifetime).
 */
export interface IPersonalizedGreeting {
  readonly text: string;
}

// ── Additional scope tags ───────────────────────────────────────────────────────

/**
 * An identifier for a scope tag BEYOND singleton/request — proves scope tags
 * are open-ended, not a fixed enum. The SAME registration, resolved from a
 * vantage point where its tag is NOT an open ancestor, doubles as the
 * TRANSIENT witness: no matching frame ⇒ a fresh instance every resolve, no
 * cache, no error (§ core principle — scopes are uniform tags).
 */
export interface IOperationId {
  readonly value: number;
}
