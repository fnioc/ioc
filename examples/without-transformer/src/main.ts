// The plugin-less wiring + entry point.
//
// This is the SAME app as ../../with-transformer, wired by hand. It imports the
// IDENTICAL contracts + service classes from `@fnioc-examples/shared` (via a
// relative source path, so plain `tsc` compiles them into this example's own
// `dist`). Diff this file against the with-transformer main.ts and the ONLY
// difference is the WIRING STYLE: without the transformer there is no type-driven
// authoring — every registration names an explicit string token, every class
// with ctor dependencies has its signature written by hand (the third `add`
// argument), and open generics are closed manually with `closeToken` / `typeArg`.
//
// Two demos below are the HEADLINE new capabilities this file exists to show off
// (search for "HEADLINE" to find them) — the SAME two with-transformer's sibling
// carries, reproduced through the explicit API:
//   - a `Promise<T>`-only registration + a recursive `resolveAsync` through it.
//   - a class registered AS a factory via a HAND-WRITTEN overload-tuple rest
//     parameter + `Reflect.construct`, proven to resolve identically to
//     registering the class directly. with-transformer derives that rest
//     parameter's type from `OverloadedConstructorParameters<typeof C>` (a
//     transformer-only utility); here it is simply hand-written as the tuple
//     union `[a, b] | [a]`, exactly like every other signature in this file is
//     hand-fed instead of derived.
// One with-transformer capability has NO explicit-API counterpart and is
// intentionally absent here: the per-scope `addRequest<I>(C)` authoring method
// is pure sugar the transformer mints from a declared scope tag; plugin-less,
// a `request`-scoped registration just uses the ordinary `.as("request")`
// continuation (see `REQUEST_ID` below) — exactly what `addRequest` lowers to.

import { closeToken, type Resolver, ServiceManifest, typeArg, union } from "@fnioc/di";

import type {
  IAppConfig,
  IAuditor,
  ILogger,
  IMetricsBackend,
  IRepository,
  IWelcomeBanner,
} from "../../shared/src/index.js";
import {
  AsyncResource,
  ConsoleLogger,
  DiagnosticsService,
  Greeter,
  InMemoryMetrics,
  InMemoryRepository,
  OperationId,
  OptionalConsumer,
  OverrideClock,
  PersonalizedGreeting,
  ReleaseChannel,
  RemoteConfig,
  RemoteConfigConsumer,
  RepositoryAuditor,
  RequestId,
  SqlRepository,
  SyncResource,
  SystemClock,
  UnionConsumer,
  appConfig,
  createWelcomeBanner,
  fetchRemoteConfig,
} from "../../shared/src/index.js";

// Our chosen tokens. The transformer would have derived source-relative ones;
// plugin-less, any stable string works — we use an `app/I<Name>` convention.
const LOGGER = "app/ILogger";
const CLOCK = "app/IClock";
const GREETER = "app/IGreeter";
const REQUEST_ID = "app/IRequestId";
const METRICS = "app/IMetricsBackend";
const UNION_CONSUMER = "app/UnionConsumer";
// Matches the token pinned by DiagnosticsService's `Inject<IClock, "..">` brand.
const PRIMARY_CLOCK = "app:primary-clock";
const DIAGNOSTICS = "app/IDiagnosticsService";
// A third scope tag beyond singleton/request (see `services` below). The SAME
// registration doubles as the TRANSIENT witness when resolved from a vantage
// where "operation" is not an open ancestor (§ core principle — scopes are
// uniform tags; no matching open frame ⇒ fresh instance, no cache, no error).
const OPERATION_ID = "app/IOperationId";

// Overloaded-signature tokens. Both point at the SAME `Reporter` class but select
// different constructor overloads (see the registrations below).
const REPORTER = "app/Reporter";
const LEAN_REPORTER = "app/LeanReporter";
// A token that is never registered — used to make the richer overload
// unsatisfiable for LEAN_REPORTER so selection falls through to the leaner one.
const ABSENT_SINK = "app/IAbsentSink";

// Open-generics tokens (manual path). Repositories register under an open
// TEMPLATE — `$1` is the hole — and each closing is addressed by the canonical
// closed form `app/IRepository<app/User>` (built with `closeToken`). Entities
// never resolve, so their tokens are just stable strings.
const REPOSITORY = "app/IRepository";
const REPOSITORY_TEMPLATE = "app/IRepository<$1>";
const AUDITOR = "app/IAuditor";
const AUDITOR_TEMPLATE = "app/IAuditor<$1>";
const USER = "app/User";
const INVOICE = "app/Invoice";
const ORDER = "app/Order";

// Factory + value registration tokens.
const WELCOME_BANNER = "app/IWelcomeBanner";
const APP_CONFIG = "app/IAppConfig";

// A FactoryRef slot target — `{ type: GREETER }` (below) injects a CALLABLE
// producing GREETER rather than a resolved instance, the slot-level
// counterpart to the top-level `resolveFactory` calls further down.
const GREETER_HOLDER = "app/GreeterHolder";

// Literal + optional dep tokens. FEATURE_TOGGLE is deliberately never
// registered — OptionalConsumer's `toggle` slot degrades to `undefined`.
const RELEASE_CHANNEL = "app/IReleaseChannel";
const OPTIONAL_CONSUMER = "app/OptionalConsumer";
const FEATURE_TOGGLE = "app/IFeatureToggle";

// Disposal tokens — a FOURTH scope tag ("session"), opened for the first time
// further down.
const SYNC_RESOURCE = "app/ISyncResource";
const ASYNC_RESOURCE = "app/IAsyncResource";

// resolveFactory's PARAMETERIZED-form target. NAME_PARAM is never registered —
// it is purely a positional marker naming which ctor slot `resolveFactory`'s
// `params` list claims as caller-supplied; the engine matches it by TOKEN
// IDENTITY against the signature, never by looking it up in the container.
const PERSONALIZED_GREETING = "app/IPersonalizedGreeting";
const NAME_PARAM = "app:name";

// ResolveScope (Resolver) injection into a factory — see `buildEnvironmentReport`
// below.
const ENV_REPORT = "app/IEnvironmentReport";

// Async-only (Promise<T>) registration tokens. REMOTE_CONFIG is never
// registered bare — only `closeToken("Promise", REMOTE_CONFIG)` is (below).
// REMOTE_CONFIG_CONSUMER's hand-written signature still names the bare token,
// exactly like its with-transformer sibling's ctor does.
const REMOTE_CONFIG = "app/IRemoteConfig";
const REMOTE_CONFIG_CONSUMER = "app/IRemoteConfigConsumer";

// Class-as-factory headline tokens — two ISOLATED throwaway containers further
// down compare `add(Reporter)` against `addFactory(overload-faithful wrapper)`.
const REPORTER_VIA_CLASS = "app/ReporterViaClass";
const REPORTER_VIA_FACTORY = "app/ReporterViaFactory";

// A class with TWO constructor overloads. Defined locally because overloaded
// construction is a plugin-less authoring feature this example exists to show:
// the resolver carries BOTH ctor signatures on one registration and greedily
// selects the FIRST whose slots are all registered.
class Reporter {
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

// `singleton`, `request`, `operation`, and `session` are the four scope tags
// this app opens. There is no root: scopes are uniform tags, and `singleton`
// is just the one we open once at the top (below, via `createScope("singleton")`)
// for app-lifetime instances.
const services = new ServiceManifest<"singleton" | "request" | "operation" | "session">();

services.add(LOGGER, ConsoleLogger).as("singleton");
services.add(CLOCK, SystemClock).as("singleton");
// Hand-written dependency signature — the inline third `add` argument, the same
// array the transformer would emit. Greeter's two params map positionally to the
// logger + clock tokens.
services.add(GREETER, Greeter, [[LOGGER, CLOCK]]).as("singleton");
services.add(REQUEST_ID, RequestId).as("request");
services.add(METRICS, InMemoryMetrics).as("singleton");
// Union slot: UnionConsumer's `sink` accepts either LOGGER or METRICS. Members
// are tried in declaration order; LOGGER is registered, so it wins.
services.add(UNION_CONSUMER, UnionConsumer, [[union(LOGGER, METRICS)]]).as("singleton");
services.add(PRIMARY_CLOCK, SystemClock);
// The Inject brand replicated by hand: DiagnosticsService's `clock` param pins
// PRIMARY_CLOCK (the with-transformer example derives this automatically).
services.add(DIAGNOSTICS, DiagnosticsService, [[PRIMARY_CLOCK, LOGGER]]).as("singleton");

// Overloaded signatures — the third `add` argument is a LIST of signatures, one
// per constructor overload, tried in order. Both registrations below offer the
// SAME two signatures ([logger, metrics] then [logger]); which overload the
// resolver selects depends only on what is registered:
//   REPORTER      — METRICS is registered, so the richer [LOGGER, METRICS]
//                   signature is satisfiable and wins.
//   LEAN_REPORTER — the richer signature names ABSENT_SINK (never registered),
//                   so it is unsatisfiable and selection falls back to [LOGGER].
services.add(REPORTER, Reporter, [[LOGGER, METRICS], [LOGGER]]).as("singleton");
services.add(LEAN_REPORTER, Reporter, [[LOGGER, ABSENT_SINK], [LOGGER]]).as("singleton");

// Open template registration: the third `add` argument carries the dep
// signatures ON the registration (a generic class can't use the ctor-keyed store
// across closings — one erased class would collide). `typeArg(1)` is the witness
// slot: at each closing it becomes the type argument's token string.
// `.as("singleton")` applies PER CLOSING — the closings are distinct singletons.
services.add(REPOSITORY_TEMPLATE, SqlRepository, [[LOGGER, typeArg(1)]]).as("singleton");

// A CLOSED (exact) registration for one entity — beats the open fallback for
// that closing. Its `Typeof<T>` witness is supplied as a literal value slot.
services.add(closeToken(REPOSITORY, ORDER), InMemoryRepository, [[{ value: ORDER }]]).as("singleton");

// A generic-on-generic open template: the auditor's dep template
// `app/IRepository<$1>` rides on the registration and is substituted per closing
// — resolving `app/IAuditor<app/User>` wires in the User repository closing.
services.add(AUDITOR_TEMPLATE, RepositoryAuditor, [[REPOSITORY_TEMPLATE]]).as("singleton");

// A THIRD scope tag (beyond singleton/request), proving scope tags are
// open-ended rather than a fixed enum — and, resolved from a vantage where
// "operation" is NOT an open ancestor (below), the SAME registration doubles as
// the TRANSIENT witness (§ core principle — scopes are uniform tags; no
// matching open frame ⇒ fresh instance every resolve, no cache, no error).
services.add(OPERATION_ID, OperationId).as("operation");

// Factory registration: the third `addFactory` argument is the SAME kind of
// hand-written dep-signature array `add` takes. `createWelcomeBanner`'s params
// (`logger`, `clock`) are injected positionally, exactly like a ctor's — only
// the REGISTRATION CALL differs from a class (`addFactory` vs `add`).
services.addFactory(WELCOME_BANNER, createWelcomeBanner, [[LOGGER, CLOCK]]).as("singleton");

// Explicit-token value authoring: `addValue(token, v)` — no deps, no lifetime.
// There is no construction step to observe, so resolving it twice trivially
// returns the identical reference (proven below).
services.addValue(APP_CONFIG, appConfig);

// A FactoryRef slot — `{ type: GREETER }` — injects a CALLABLE producing GREETER
// instead of a resolved instance. Declared locally (like `Reporter` above): the
// feature under test is the SLOT KIND, not a new shared service.
class GreeterHolder {
  public constructor(public readonly makeGreeter: () => Greeter) {}
}
services.add(GREETER_HOLDER, GreeterHolder, [[{ type: GREETER }]]).as("singleton");

// A whole-type LITERAL ctor parameter (`channel: "stable"`, not the widened
// `string` the interface declares) derives a `LiteralRef` slot — hand-written
// here as the `{ value: "stable" }` slot literal, always satisfiable, no token
// and no registration needed for the dep itself.
services.add(RELEASE_CHANNEL, ReleaseChannel, [[{ value: "stable" }]]).as("singleton");

// An OPTIONAL ctor param (`toggle?: IFeatureToggle`) whose token (FEATURE_TOGGLE)
// is never registered: the hand-written `union(...)` slot pairs it with a
// `{ value: undefined }` fallback member, replicating what the transformer
// derives automatically from a `?` / default / `| undefined` param — the
// always-satisfiable LiteralRef supplies `undefined` instead of throwing.
services
  .add(OPTIONAL_CONSUMER, OptionalConsumer, [[union(FEATURE_TOGGLE, { value: undefined })]])
  .as("singleton");

// Disposal: both resource classes are tagged "session" — a FOURTH scope tag,
// opened for the first time further down. `dispose()`/`disposeAsync()` only
// ever tear down the ONE frame they are called on (no cascade to children),
// disposing the instances that frame owns in REVERSE construction order.
services.add(SYNC_RESOURCE, SyncResource, [[LOGGER]]).as("session");
services.add(ASYNC_RESOURCE, AsyncResource, [[LOGGER]]).as("session");

// resolveFactory's PARAMETERIZED-form target: one registered dep (`logger`) and
// one caller-supplied dep (`name` — NAME_PARAM is never registered; it just
// names the slot `resolveFactory`'s `params` list claims). Never resolved via
// plain `resolve(PERSONALIZED_GREETING)` in this file (its `name` slot has no
// registered value) — only via `resolveFactory`'s parameterized form below.
services.add(PERSONALIZED_GREETING, PersonalizedGreeting, [[LOGGER, NAME_PARAM]]).as("singleton");

// ResolveScope (Resolver) injection into a factory: a hand-written `{ scope:
// true }` slot — the ScopeRef literal — fills the parameter with the LIVE
// resolution scope instead of a resolved token, so the factory body can
// `sp.resolve(...)` imperatively. Declared LOCALLY (not in shared/contracts.ts):
// the feature under test is the injection mechanism, not a new shared service —
// mirrors how the with-transformer sibling declares its own local
// `IEnvironmentReport` for the same reason.
interface IEnvironmentReport {
  readonly text: string;
}
function buildEnvironmentReport(sp: Resolver): IEnvironmentReport {
  const cfg = sp.resolve<IAppConfig>(APP_CONFIG);
  const clock = sp.resolve<SystemClock>(CLOCK);
  return { text: `[${cfg.environment}@${cfg.version}] as of ${clock.now()}` };
}
services.addFactory(ENV_REPORT, buildEnvironmentReport, [[{ scope: true }]]).as("singleton");

// HEADLINE: a type registered ONLY as `Promise<app/IRemoteConfig>` — the exact
// closed-generic token the runtime `closeToken` produces, hand-built the same
// way. Nothing in this program ever registers bare REMOTE_CONFIG.
// RemoteConfigConsumer's hand-written signature depends on that BARE token
// anyway; `resolveAsync` on REMOTE_CONFIG_CONSUMER (below) succeeds by
// recursively resolving REMOTE_CONFIG via the honest `Promise<T>` fallback and
// awaiting it before the constructor ever runs. `fetchRemoteConfig` takes no
// parameters, so its hand-written signature is `[[]]` — one signature, zero
// slots — rather than omitting the third argument entirely, which would route
// it through the record-less escape hatch and hand it the live provider instead
// (harmless here since the extra arg would be ignored, but `[[]]` says
// truthfully what this factory's real arity is).
services.addFactory(closeToken("Promise", REMOTE_CONFIG), fetchRemoteConfig, [[]]).as("singleton");
services.add(REMOTE_CONFIG_CONSUMER, RemoteConfigConsumer, [[REMOTE_CONFIG]]).as("singleton");

// build() returns a frameless provider — nothing is pre-opened. Open the
// "singleton" scope explicitly so singleton-tagged registrations cache for the
// app's lifetime. (Resolving them off the frameless provider would be transient.)
const root = services.build().createScope("singleton");

// Resolve the greeter twice from the singleton scope. As a singleton it is the
// same instance both times, so the singleton logger it holds accumulates every line.
const greeterA = root.resolve<Greeter>(GREETER);
const greeterB = root.resolve<Greeter>(GREETER);

greeterA.greet("Ada");
greeterB.greet("Linus");

const logger = root.resolve<ConsoleLogger>(LOGGER);

// Two request child scopes, each owning its own request-scoped id.
const req1 = root.createScope("request");
const id1a = req1.resolve<RequestId>(REQUEST_ID);
const id1b = req1.resolve<RequestId>(REQUEST_ID);

const req2 = root.createScope("request");
const id2 = req2.resolve<RequestId>(REQUEST_ID);

// Two independent "operation" child scopes: stable within one, distinct across.
const op1 = root.createScope("operation");
const op1a = op1.resolve<OperationId>(OPERATION_ID);
const op1b = op1.resolve<OperationId>(OPERATION_ID);

const op2 = root.createScope("operation");
const op2a = op2.resolve<OperationId>(OPERATION_ID);

// TRANSIENT: resolved straight from `root`, whose open chain is JUST
// "singleton" — no "operation" frame anywhere in it. The exact same
// registration now yields a fresh instance on EVERY resolve: no cache, no error.
const opTransientA = root.resolve<OperationId>(OPERATION_ID);
const opTransientB = root.resolve<OperationId>(OPERATION_ID);

// Union demo: UnionConsumer resolved to ILogger (first in union, registered).
const unionConsumer = root.resolve<UnionConsumer>(UNION_CONSUMER);
unionConsumer.emit("union-test");

// Inject demo: DiagnosticsService's clock pinned to PRIMARY_CLOCK by hand.
const diag = root.resolve<DiagnosticsService>(DIAGNOSTICS);
const diagResult = diag.diagnose();

// Overloaded-signature demo: same class, two registrations, different overload
// selected by what is registered.
const reporter = root.resolve<Reporter>(REPORTER);
const leanReporter = root.resolve<Reporter>(LEAN_REPORTER);

// Open-generics demo: resolve closings of the open template. Each closed token
// is its own cache key, so the closings are distinct singletons of the SAME
// erased class; the typeArg(1) witness tells each instance its entity.
const userRepo = root.resolve<IRepository<unknown>>(closeToken(REPOSITORY, USER));
const userRepoAgain = root.resolve<IRepository<unknown>>(closeToken(REPOSITORY, USER));
const invoiceRepo = root.resolve<IRepository<unknown>>(closeToken(REPOSITORY, INVOICE));
const orderRepo = root.resolve<IRepository<unknown>>(closeToken(REPOSITORY, ORDER));
const userSave = userRepo.save({ name: "Ada" });
const invoiceSave = invoiceRepo.save({ id: 7 });
const orderSave = orderRepo.save({ id: 42 });

// The auditor's hole-template dep closes recursively: its repo dep is the
// SAME instance as the User repository closing above.
const auditor = root.resolve<IAuditor<unknown>>(closeToken(AUDITOR, USER));

// Factory registration resolved.
const welcomeBanner = root.resolve<IWelcomeBanner>(WELCOME_BANNER);

// Value registration resolved twice — trivially the same reference.
const resolvedConfig = root.resolve<IAppConfig>(APP_CONFIG);
const resolvedConfigAgain = root.resolve<IAppConfig>(APP_CONFIG);

// FactoryRef slot resolved — GreeterHolder's ctor received a CALLABLE, not a
// resolved Greeter. Calling it routes through the normal resolve path (no
// `params` on the slot), so it RESPECTS Greeter's registered singleton lifetime.
const greeterHolder = root.resolve<GreeterHolder>(GREETER_HOLDER);

// Literal dep resolved — no registration ever supplied "stable" as a value.
const releaseChannel = root.resolve<ReleaseChannel>(RELEASE_CHANNEL);

// Optional dep resolved — FEATURE_TOGGLE is never registered anywhere.
const optionalConsumer = root.resolve<OptionalConsumer>(OPTIONAL_CONSUMER);

// resolveFactory — ZERO-ARG form: every slot resolves from the container, and
// the result RESPECTS the target's registered lifetime (Greeter is already a
// singleton above; calling this factory returns THAT SAME cached instance,
// proven below).
const greeterFactory = root.resolveFactory(GREETER) as () => Greeter;

// resolveFactory — PARAMETERIZED form: NAME_PARAM is caller-supplied per call,
// `logger` still resolves from the container. Bypasses the instance cache
// ENTIRELY — a fresh instance every call, regardless of any lifetime tag.
const personalize = root.resolveFactory(PERSONALIZED_GREETING, [NAME_PARAM]) as (
  name: string,
) => PersonalizedGreeting;
const personalizedBob = personalize("Bob");
const personalizedCarol = personalize("Carol");

// ResolveScope factory resolved — it resolved IAppConfig + IClock imperatively
// from inside its own body rather than declaring them as ctor-like params.
const envReport = root.resolve<IEnvironmentReport>(ENV_REPORT);

// HEADLINE: async. `resolveAsync` on REMOTE_CONFIG finds the Promise-typed
// registration directly (via the honest `Promise<T>` fallback); `resolveAsync`
// on REMOTE_CONFIG_CONSUMER never finds a registration for the BARE token it
// depends on and instead recurses through the same fallback, awaiting it
// before construction.
const remoteConfig = await root.resolveAsync<RemoteConfig>(REMOTE_CONFIG);
const remoteConfigConsumer = await root.resolveAsync<RemoteConfigConsumer>(REMOTE_CONFIG_CONSUMER);

// Disposal. `sessionA` owns only a sync-disposable — `dispose()` (sync) tears
// it down directly. `sessionB` owns BOTH kinds, constructed sync-THEN-async —
// `disposeAsync()` handles either `Symbol.dispose` or `Symbol.asyncDispose` and
// disposes its owned instances in REVERSE construction order, so the
// async-resource's teardown log line lands before the sync-resource's.
const sessionA = root.createScope("session");
const syncResourceA = sessionA.resolve<SyncResource>(SYNC_RESOURCE);
sessionA.dispose();

const sessionB = root.createScope("session");
const syncResourceB = sessionB.resolve<SyncResource>(SYNC_RESOURCE); // constructed FIRST
const asyncResourceB = sessionB.resolve<AsyncResource>(ASYNC_RESOURCE); // constructed SECOND
const linesBeforeDispose = logger.lines.length;
await sessionB.disposeAsync();
const disposalOrder = logger.lines.slice(linesBeforeDispose);

// Last-wins override — isolated in its OWN throwaway container: an override
// registered on the shared `services` above would retroactively change
// Greeter's clock (already resolved). CLOCK is registered TWICE here —
// SystemClock, then OverrideClock — and the engine keeps BOTH (an override
// never deletes a prior registration) but always resolves the MOST RECENT one.
const overrideDemo = new ServiceManifest<"singleton">();
overrideDemo.add(CLOCK, SystemClock).as("singleton");
overrideDemo.add(CLOCK, OverrideClock).as("singleton"); // registered SECOND — wins
const overriddenClock = overrideDemo.build().createScope("singleton").resolve<OverrideClock>(CLOCK);

// HEADLINE: register a class AS a factory via a hand-written overload-tuple
// wrapper. Two independent, throwaway containers isolate the comparison —
// registering both forms under the SAME token in ONE container would just be
// another last-wins override (above), not a side-by-side proof. Each wires
// IDENTICAL deps (ConsoleLogger + InMemoryMetrics); if the wrapper is faithful,
// both resolve to behaviorally identical Reporters.
const viaClassManifest = new ServiceManifest<"singleton">();
viaClassManifest.add(LOGGER, ConsoleLogger).as("singleton");
viaClassManifest.add(METRICS, InMemoryMetrics).as("singleton");
viaClassManifest.add(REPORTER_VIA_CLASS, Reporter, [[LOGGER, METRICS], [LOGGER]]).as("singleton");
const classReporter = viaClassManifest
  .build()
  .createScope("singleton")
  .resolve<Reporter>(REPORTER_VIA_CLASS);

const viaFactoryManifest = new ServiceManifest<"singleton">();
viaFactoryManifest.add(LOGGER, ConsoleLogger).as("singleton");
viaFactoryManifest.add(METRICS, InMemoryMetrics).as("singleton");
// THE NEW CAPABILITY: `Reporter` registered AS A FACTORY. The rest parameter's
// type is HAND-WRITTEN as the tuple union `[a, b] | [a]` — the overload-faithful
// analog of with-transformer's transformer-derived
// `OverloadedConstructorParameters<typeof Reporter>` — carrying BOTH
// constructor overloads (not just the last one a builtin `ConstructorParameters`
// would see); the SAME two-signature list from REPORTER above drives the SAME
// greedy longest-satisfiable selection over the wrapped factory.
viaFactoryManifest
  .addFactory(
    REPORTER_VIA_FACTORY,
    (...args: [ILogger, IMetricsBackend] | [ILogger]) => Reflect.construct(Reporter, args),
    [[LOGGER, METRICS], [LOGGER]],
  )
  .as("singleton");
const factoryReporter = viaFactoryManifest
  .build()
  .createScope("singleton")
  .resolve<Reporter>(REPORTER_VIA_FACTORY);

const lines = [
  "=== @fnioc/di — without transformer ===",
  `greeter is a shared singleton: ${greeterA === greeterB}`,
  `Greeter instances built: ${Greeter.built}`,
  `ConsoleLogger instances built: ${ConsoleLogger.built}`,
  `SystemClock instances built: ${SystemClock.built}`,
  "logged lines:",
  ...logger.lines.map((line) => `  ${line}`),
  `request 1 id stable within scope: ${id1a === id1b} (value ${id1a.value})`,
  `request 2 id is distinct: ${id2.value !== id1a.value} (value ${id2.value})`,
  `RequestId instances built: ${RequestId.built}`,
  `union resolved to logger (first in union): ${(unionConsumer.sink as { log?: unknown }).log !== undefined}`,
  `inject brand pinned correct clock: ${diagResult.includes("2026-01-01")}`,
  "overloaded signatures:",
  `  richer overload chosen when its deps are present: ${reporter.report() === "with-metrics"}`,
  `  falls back to the leaner overload when a dep is absent: ${leanReporter.report() === "logger-only"}`,
  "open generics:",
  `  user repo is a per-closing singleton: ${userRepo === userRepoAgain}`,
  `  distinct closings are distinct instances: ${userRepo !== invoiceRepo}`,
  `  user save: ${userSave}`,
  `  invoice save: ${invoiceSave}`,
  `  SqlRepository instances built: ${SqlRepository.built}`,
  `  closed registration wins for Order: ${orderRepo.kind}`,
  `  order save: ${orderSave}`,
  `  auditor closed over the user repo: ${auditor.repo === userRepo} (${auditor.audit()})`,
  "scopes — a third custom tag, and TRANSIENT (no matching open frame):",
  `  operation id stable within one frame: ${op1a === op1b} (value ${op1a.value})`,
  `  operation id distinct across sibling frames: ${op1a.value !== op2a.value} (value ${op2a.value})`,
  `  same registration, no open "operation" frame here => transient: ${opTransientA !== opTransientB}`,
  "factory registration — addFactory(token, fn, [[...]]):",
  `  welcome banner built via factory: ${welcomeBanner.text}`,
  "addValue(token, v) — a pre-built instance, no construction step:",
  `  resolving twice trivially returns the identical reference: ${resolvedConfig === resolvedConfigAgain} (${resolvedConfig.environment}@${resolvedConfig.version})`,
  `FactoryRef slot — a ctor param injected with a callable, not a resolved instance: ${greeterHolder.makeGreeter() === greeterA}`,
  `Typeof<T> witness — the erased SqlRepository knows its own closing: ${userRepo.entityToken}`,
  `literal dep — channel injected via a hand-written { value: "stable" } slot, no token or registration: ${releaseChannel.channel === "stable"}`,
  `optional dep — unregistered FEATURE_TOGGLE degrades to undefined, never throws: ${optionalConsumer.describe()}`,
  "resolveFactory — zero-arg (respects lifetime) vs parameterized (always fresh):",
  `  zero-arg factory returns the SAME cached singleton: ${greeterFactory() === greeterA}`,
  `  parameterized factory builds fresh every call: ${personalizedBob !== personalizedCarol}`,
  `  ${personalizedBob.text} / ${personalizedCarol.text}`,
  `ResolveScope (Resolver) injection — factory resolved its own deps imperatively: ${envReport.text}`,
  "=== HEADLINE: async — Promise<T>-only registration + recursive resolveAsync ===",
  `  resolveAsync(REMOTE_CONFIG) directly: ${remoteConfig.endpoint}`,
  `  resolveAsync(REMOTE_CONFIG_CONSUMER) recursively resolved the bare token via the Promise<T> fallback: ${remoteConfigConsumer.describe()}`,
  `  RemoteConfig built exactly once — shared singleton cache through the async fallback: ${RemoteConfig.built === 1}`,
  "disposal — Symbol.dispose (sync) vs Symbol.asyncDispose (async):",
  `  sync dispose() tore down the sync-only scope: ${syncResourceA.disposed}`,
  `  disposeAsync() tore down both, REVERSE of construction order: ${disposalOrder[0]?.includes("async-resource") === true && disposalOrder[1]?.includes("sync-resource") === true}`,
  `  disposal log order: ${disposalOrder.join(" then ")}`,
  "last-wins override (registering a token twice — the engine keeps both, resolves the most recent):",
  `  bare CLOCK now resolves the override: ${overriddenClock instanceof OverrideClock} (${overriddenClock.now()})`,
  "=== HEADLINE: class-as-factory via a hand-written overload-tuple wrapper ===",
  `  addFactory(overload-faithful wrapper) resolves identically to add(Reporter): ${classReporter.report() === factoryReporter.report()} (both: "${factoryReporter.report()}")`,
  `  Reflect.construct really built a genuine Reporter: ${factoryReporter instanceof Reporter}`,
];

for (const line of lines) {
  console.log(line);
}
