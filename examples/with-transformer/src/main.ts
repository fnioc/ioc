// The type-driven wiring + entry point — the FULL kitchen sink.
//
// The contracts and service CLASSES live in `@fnioc-examples/shared` — imported
// below via a relative source path so `tspc` compiles them into this example's
// own `dist`. The ONLY thing this file adds over the without-transformer example
// is the WIRING STYLE: registration is authored interface-first
// (`services.add<IGreeter>(Greeter)`, no runtime token), resolution is tokenless
// (`resolve<IGreeter>()`), and open generics use `$<N>` / `Typeof<T>`
// placeholders. At build time @fnioc/transformer rewrites each call to its
// explicit-token form, carrying the derived dep signature INLINE as the `add`
// call's third argument. Inspect `dist/with-transformer/src/main.js` after
// building to see the lowered output.
//
// The transformer lowers TOP-LEVEL `.add(...)` / `.resolve(...)` statements, so
// every registration and resolve below sits at module scope or reads a
// module-scope binding — but a tokenless `resolve<T>()` reachable from a
// top-level statement is rewritten no matter how deeply it is NESTED (inside a
// factory body, for instance): the rewrite recurses through the whole statement
// subtree, only the registration methods themselves require top-level
// placement. `resolveAsync` has no tokenless sugar at all (it isn't part of the
// transformer's `resolve`-rewrite), so every `resolveAsync<T>()` call below is
// given its token explicitly via `nameof<T>()` — itself rewritten to a
// compile-time string literal wherever it appears.
//
// Three demos below are the HEADLINE new capabilities this file exists to show
// off (search for "HEADLINE" to find them):
//   - tokenless `addFactory<I>(fn)` — a factory registered with no runtime token.
//   - a `Promise<T>`-only registration + a recursive `resolveAsync` through it.
//   - a class registered AS a factory via the overload-faithful
//     `OverloadedConstructorParameters<typeof C>` + `Reflect.construct` wrapper,
//     proven to resolve identically to registering the class directly.

import { type $, type ResolveScope, ServiceManifest } from "@fnioc/di";
import { nameof, type OverloadedConstructorParameters } from "@fnioc/transformer";

import type {
  IAppConfig,
  IAsyncResource,
  IAuditor,
  IClock,
  IDiagnosticsService,
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
} from "../../shared/src/index.js";
import {
  AsyncResource,
  ConsoleLogger,
  DiagnosticsService,
  Greeter,
  InMemoryMetrics,
  InMemoryRepository,
  Invoice,
  OperationId,
  OptionalConsumer,
  Order,
  OverrideClock,
  PersonalizedGreeting,
  ReleaseChannel,
  RemoteConfig,
  RemoteConfigConsumer,
  RepositoryAuditor,
  Reporter,
  RequestId,
  SqlRepository,
  SyncResource,
  SystemClock,
  UnionConsumer,
  User,
  appConfig,
  createWelcomeBanner,
  fetchRemoteConfig,
} from "../../shared/src/index.js";

// `singleton`, `request`, `operation`, and `session` are the four scope tags
// this app opens. There is no root: scopes are uniform tags, and `singleton`
// is just the one we open once at the top (below, via
// `createScope("singleton")`) for app-lifetime instances.
const services = new ServiceManifest<"singleton" | "request" | "operation" | "session">();

services.add<ILogger>(ConsoleLogger).as<"singleton">();
services.add<IClock>(SystemClock).as<"singleton">();
services.add<IGreeter>(Greeter).as<"singleton">();
services.add<IMetricsBackend>(InMemoryMetrics).as<"singleton">();

// Per-scope authoring: `addRequest<I>(C)` lowers to `add("token", C).as("request")`
// — the scope tag rides on the METHOD NAME (`add${ProperCase<K>}`, one minted
// per declared scope tag) instead of a trailing `.as<"request">()` continuation.
// Same runtime effect as `add<IRequestId>(RequestId).as<"request">()`; purely
// an authoring-style choice, and (per the file header) available ONLY with the
// transformer in the program.
services.addRequest<IRequestId>(RequestId);

// Inline-union demo: UnionConsumer takes `ILogger | IMetricsBackend`. The
// transformer emits a union slot; ILogger is declared first so it wins.
services.add(UnionConsumer).as<"singleton">();

// Inject-brand demo: DiagnosticsService's `clock` param is branded
// `Inject<IClock, "app:primary-clock">`, so the transformer emits that token for
// the slot. Register SystemClock under it so resolution succeeds.
services.add("app:primary-clock", SystemClock);
services.add<IDiagnosticsService>(DiagnosticsService).as<"singleton">();

// Open-generics demo: ONE open registration (the `$<1>` placeholder marks the
// hole) covers every closing of IRepository<T>. The transformer lowers this to a
// template token with SqlRepository's dep signatures carried on the
// registration; the container closes it per resolved token. `.as<"singleton">()`
// applies PER CLOSING — `IRepository<User>` and `IRepository<Invoice>` are
// distinct singletons.
services.add<IRepository<$<1>>>(SqlRepository<$<1>>).as<"singleton">();

// A CLOSED generic registration via an instantiation expression: exact tokens
// always beat the open fallback, so `IRepository<Order>` resolves the in-memory
// impl while every other closing falls back to SqlRepository.
services.add<IRepository<Order>>(InMemoryRepository<Order>).as<"singleton">();

// A generic service depending on a generic: the auditor's `IRepository<T>` dep
// closes recursively per requested closing.
services.add<IAuditor<$<1>>>(RepositoryAuditor<$<1>>).as<"singleton">();

// A THIRD scope tag (beyond singleton/request), proving scope tags are
// open-ended rather than a fixed enum — and, resolved from a vantage where
// "operation" is NOT an open ancestor (below), the SAME registration doubles as
// the TRANSIENT witness (§ core principle — scopes are uniform tags; no
// matching open frame ⇒ fresh instance every resolve, no cache, no error).
services.add<IOperationId>(OperationId).as<"operation">();

// HEADLINE: tokenless `addFactory<I>(fn)` — a factory registered with NO
// runtime token, exactly like `add<I>(C)` for a class. `createWelcomeBanner`'s
// params (`logger`, `clock`) are injected exactly like a ctor's; only the
// REGISTRATION CALL differs from a class (`addFactory` vs `add`).
services.addFactory<IWelcomeBanner>(createWelcomeBanner).as<"singleton">();

// Tokenless value authoring: `addValue<I>(v)` — no deps, no lifetime. There is
// no construction step to observe, so resolving it twice trivially returns the
// identical reference (proven below).
services.addValue<IAppConfig>(appConfig);

// A whole-type LITERAL ctor parameter (`channel: "stable"`, not the widened
// `string` the interface declares) derives a `LiteralRef` slot straight from
// the TYPE — always satisfiable, no token and no registration needed for the
// DEP itself. `ReleaseChannel` the SERVICE still needs registering so it can be
// resolved.
services.add<IReleaseChannel>(ReleaseChannel).as<"singleton">();

// An OPTIONAL ctor param (`toggle?: IFeatureToggle`) whose token is NEVER
// registered anywhere in this program: the engine's `{ value: undefined }`
// fallback supplies `undefined` instead of throwing. No dedicated interface —
// resolved by its own class, exactly like `UnionConsumer` above.
services.add(OptionalConsumer).as<"singleton">();

// Overload selection: `Reporter` carries TWO constructor overloads
// (`(logger, metrics)` and `(logger)`); the transformer emits both as one
// registration and the engine greedily picks the longest SATISFIABLE one,
// tried longest-first. `IMetricsBackend` is already registered above, so the
// richer overload wins (proven below).
services.add<IReporter>(Reporter).as<"singleton">();

// Disposal: both resource classes are tagged "session" — a FOURTH scope tag,
// opened for the first time further down. `dispose()`/`disposeAsync()` only
// ever tear down the ONE frame they are called on (no cascade to children),
// disposing the instances that frame owns in REVERSE construction order.
services.add<ISyncResource>(SyncResource).as<"session">();
services.add<IAsyncResource>(AsyncResource).as<"session">();

// resolveFactory's PARAMETERIZED-form target: one registered dep (`logger`) and
// one caller-supplied dep (`name` — nobody registers a single global "name").
// Never resolved via plain `resolve<IPersonalizedGreeting>()` in this file
// (its `name: string` slot has no registered value) — only via
// `resolveFactory`'s parameterized form below, which claims that slot as
// caller-supplied instead of requiring it registered.
services.add<IPersonalizedGreeting>(PersonalizedGreeting).as<"singleton">();

// ResolveScope (Resolver) injection into a factory. Declared LOCALLY (not in
// shared/contracts.ts): the feature under test is the INJECTION MECHANISM, not
// a new shared service — `IEnvironmentReport` exists only to give it a return
// type, mirroring how without-transformer declares its own local `Reporter`
// when a feature is specific to demonstrating one authoring capability.
interface IEnvironmentReport {
  readonly text: string;
}

// A factory can decline fixed positional deps entirely and instead ask for the
// LIVE resolution scope: a parameter typed `ResolveScope` receives it and can
// `resolve()` (or `createScope()`) imperatively. `ResolveScope` — not the
// newer `Resolver` — is the name that matters here: the transformer's
// structural detection keys off this EXACT type (`isResolveScopeType`), even
// though it is the deprecated alias; the injected value is a full `Resolver`
// either way. The nested `resolve<T>()` calls below are tokenless too — per
// the file header, the transformer's resolve-rewrite isn't confined to
// top-level statements, only the registration methods are.
function buildEnvironmentReport(sp: ResolveScope): IEnvironmentReport {
  const cfg = sp.resolve<IAppConfig>();
  const clock = sp.resolve<IClock>();
  return { text: `[${cfg.environment}@${cfg.version}] as of ${clock.now()}` };
}
services.addFactory<IEnvironmentReport>(buildEnvironmentReport).as<"singleton">();

// HEADLINE: a type registered ONLY as `Promise<IRemoteConfig>` — see
// `fetchRemoteConfig` in shared/services.ts. Nothing in this program ever
// registers bare `IRemoteConfig`. `RemoteConfigConsumer`'s constructor depends
// on that BARE token anyway; `resolveAsync<IRemoteConfigConsumer>()` (below)
// succeeds by recursively resolving `IRemoteConfig` via the honest
// `Promise<IRemoteConfig>` fallback and awaiting it before the constructor ever
// runs.
services.addFactory<Promise<IRemoteConfig>>(fetchRemoteConfig).as<"singleton">();
services.add<IRemoteConfigConsumer>(RemoteConfigConsumer).as<"singleton">();

// build() returns a frameless provider — nothing is pre-opened. Open the
// "singleton" scope explicitly so singleton-tagged registrations cache for the
// app's lifetime. (Resolving them off the frameless provider would be transient.)
const root = services.build().createScope("singleton");

// Resolve the greeter twice from the singleton scope. As a singleton it is the
// same instance both times, so the singleton logger it holds accumulates every line.
const greeterA = root.resolve<IGreeter>();
const greeterB = root.resolve<IGreeter>();

greeterA.greet("Ada");
greeterB.greet("Linus");

const logger = root.resolve<ILogger>();

// Two request child scopes, each owning its own request-scoped id (registered
// above via `addRequest`, not `add().as()` — see checklist item 19).
const req1 = root.createScope("request");
const id1a = req1.resolve<IRequestId>();
const id1b = req1.resolve<IRequestId>();

const req2 = root.createScope("request");
const id2 = req2.resolve<IRequestId>();

// Two independent "operation" child scopes: stable within one, distinct across.
const op1 = root.createScope("operation");
const op1a = op1.resolve<IOperationId>();
const op1b = op1.resolve<IOperationId>();

const op2 = root.createScope("operation");
const op2a = op2.resolve<IOperationId>();

// TRANSIENT: resolved straight from `root`, whose open chain is JUST
// "singleton" — no "operation" frame anywhere in it. The exact same
// registration now yields a fresh instance on EVERY resolve: no cache, no error.
const opTransientA = root.resolve<IOperationId>();
const opTransientB = root.resolve<IOperationId>();

// Union demo: UnionConsumer resolved to ILogger (first in union, registered).
const unionConsumer = root.resolve<UnionConsumer>();
unionConsumer.emit("union-test");

// Inject demo: DiagnosticsService registered under IDiagnosticsService's token.
const diag = root.resolve<IDiagnosticsService>();
const diagResult = diag.diagnose();

// Open-generics demo: tokenless authored resolves — the transformer derives the
// closed token from the type argument. Each closing is its own singleton; the
// Typeof witness lets the erased class print WHICH closing it is.
const userRepo = root.resolve<IRepository<User>>();
const userRepoAgain = root.resolve<IRepository<User>>();
const invoiceRepo = root.resolve<IRepository<Invoice>>();
const orderRepo = root.resolve<IRepository<Order>>();
const userSave = userRepo.save(new User());
const invoiceSave = invoiceRepo.save(new Invoice());
const orderSave = orderRepo.save(new Order());

// Generic-on-generic: the auditor closing over User shares the User repository.
const auditor = root.resolve<IAuditor<User>>();

// Factory registration resolved.
const welcomeBanner = root.resolve<IWelcomeBanner>();

// Value registration resolved twice — trivially the same reference.
const resolvedConfig = root.resolve<IAppConfig>();
const resolvedConfigAgain = root.resolve<IAppConfig>();

// Literal dep resolved — no registration ever supplied "stable" as a value.
const releaseChannel = root.resolve<IReleaseChannel>();

// Optional dep resolved — IFeatureToggle is never registered anywhere.
const optionalConsumer = root.resolve<OptionalConsumer>();

// Overload selection resolved — the richer (logger, metrics) overload wins.
const reporter = root.resolve<IReporter>();

// resolveFactory — ZERO-ARG form: every slot resolves from the container, and
// the result RESPECTS the target's registered lifetime (Greeter is already a
// singleton above; calling this factory returns THAT SAME cached instance,
// proven below).
const greeterFactory = root.resolve<() => IGreeter>();

// resolveFactory — PARAMETERIZED form: `name` is caller-supplied per call,
// `logger` still resolves from the container. Bypasses the instance cache
// ENTIRELY — a fresh instance every call, regardless of any lifetime tag.
const personalize = root.resolve<(name: string) => IPersonalizedGreeting>();
const personalizedBob = personalize("Bob");
const personalizedCarol = personalize("Carol");

// ResolveScope factory resolved — it resolved IAppConfig + IClock imperatively
// from inside its own body rather than declaring them as ctor-like params.
const envReport = root.resolve<IEnvironmentReport>();

// HEADLINE: async. Neither call below has tokenless sugar (`resolveAsync`
// isn't part of the transformer's rewrite), so each is given its token
// explicitly via `nameof<T>()` — itself rewritten to a compile-time string
// literal. `resolveAsync<IRemoteConfig>()` finds the Promise-typed
// registration directly; `resolveAsync<IRemoteConfigConsumer>()` never finds a
// registration for the BARE token it depends on and instead recurses through
// the `Promise<IRemoteConfig>` fallback, awaiting it before construction.
const remoteConfig = await root.resolveAsync<IRemoteConfig>(nameof<IRemoteConfig>());
const remoteConfigConsumer = await root.resolveAsync<IRemoteConfigConsumer>(
  nameof<IRemoteConfigConsumer>(),
);

// Disposal. `sessionA` owns only a sync-disposable — `dispose()` (sync) tears
// it down directly. `sessionB` owns BOTH kinds, constructed sync-THEN-async —
// `disposeAsync()` handles either `Symbol.dispose` or `Symbol.asyncDispose` and
// disposes its owned instances in REVERSE construction order, so the
// async-resource's teardown log line lands before the sync-resource's.
const sessionA = root.createScope("session");
const syncResourceA = sessionA.resolve<ISyncResource>();
sessionA.dispose();

const sessionB = root.createScope("session");
const syncResourceB = sessionB.resolve<ISyncResource>(); // constructed FIRST
const asyncResourceB = sessionB.resolve<IAsyncResource>(); // constructed SECOND
const linesBeforeDispose = logger.lines.length;
await sessionB.disposeAsync();
const disposalOrder = logger.lines.slice(linesBeforeDispose);

// Last-wins override — isolated in its OWN throwaway container: an override
// registered on the shared `services` above would retroactively change
// Greeter's clock (already resolved). IClock is registered TWICE here —
// SystemClock, then OverrideClock — and the engine keeps BOTH (an override
// never deletes a prior registration) but always resolves the MOST RECENT one.
const overrideDemo = new ServiceManifest<"singleton">();
overrideDemo.add<IClock>(SystemClock).as<"singleton">();
overrideDemo.add<IClock>(OverrideClock).as<"singleton">(); // registered SECOND — wins
const overriddenClock = overrideDemo.build().createScope("singleton").resolve<IClock>();

// HEADLINE: register a class AS a factory via the overload-faithful wrapper.
// Two independent, throwaway containers isolate the comparison — registering
// both forms under the SAME token in ONE container would just be another
// last-wins override (above), not a side-by-side proof. Each wires IDENTICAL
// deps (ConsoleLogger + InMemoryMetrics); if the wrapper is faithful, both
// resolve to behaviorally identical Reporters.
const viaClassManifest = new ServiceManifest<"singleton">();
viaClassManifest.add<ILogger>(ConsoleLogger).as<"singleton">();
viaClassManifest.add<IMetricsBackend>(InMemoryMetrics).as<"singleton">();
viaClassManifest.add<IReporter>(Reporter).as<"singleton">();
const classReporter = viaClassManifest.build().createScope("singleton").resolve<IReporter>();

const viaFactoryManifest = new ServiceManifest<"singleton">();
viaFactoryManifest.add<ILogger>(ConsoleLogger).as<"singleton">();
viaFactoryManifest.add<IMetricsBackend>(InMemoryMetrics).as<"singleton">();
// THE NEW CAPABILITY: `Reporter` registered AS A FACTORY. The rest parameter's
// type carries EVERY constructor overload (a union of parameter tuples — not
// just the LAST overload, which is all the builtin `ConstructorParameters`
// would see); the transformer expands it into one dep signature per overload,
// so the SAME greedy longest-satisfiable selection applies to the wrapped
// factory as to a direct class registration.
viaFactoryManifest
  .addFactory<IReporter>(
    (...args: OverloadedConstructorParameters<typeof Reporter>) =>
      Reflect.construct(Reporter, args),
  )
  .as<"singleton">();
const factoryReporter = viaFactoryManifest.build().createScope("singleton").resolve<IReporter>();

const lines = [
  "=== @fnioc/di — with transformer ===",
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
  "open generics:",
  `  user repo is a per-closing singleton: ${userRepo === userRepoAgain}`,
  `  distinct closings are distinct instances: ${userRepo !== (invoiceRepo as IRepository<unknown>)}`,
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
  `  class registration proof — resolved instance really is a Greeter: ${greeterA instanceof Greeter}`,
  `  per-scope addRequest(...) authoring still isolates correctly: ${id1a === id1b && id1a.value !== id2.value}`,
  "tokenless addFactory<I>(fn) [HEADLINE]:",
  `  welcome banner built via factory: ${welcomeBanner.text}`,
  "addValue<I>(v) — a pre-built instance, no construction step:",
  `  resolving twice trivially returns the identical reference: ${resolvedConfig === resolvedConfigAgain} (${resolvedConfig.environment}@${resolvedConfig.version})`,
  `Typeof<T> witness — the erased SqlRepository knows its own closing: ${userRepo.entityToken}`,
  `literal dep — channel injected straight from its TYPE, no token or registration: ${releaseChannel.channel === "stable"}`,
  `optional dep — unregistered token degrades to undefined, never throws: ${optionalConsumer.describe()}`,
  "overload selection — longest satisfiable signature wins:",
  `  richer (logger, metrics) overload chosen because IMetricsBackend is registered: ${reporter.report() === "with-metrics"}`,
  "resolveFactory — zero-arg (respects lifetime) vs parameterized (always fresh):",
  `  zero-arg factory returns the SAME cached singleton: ${greeterFactory() === greeterA}`,
  `  parameterized factory builds fresh every call: ${personalizedBob !== personalizedCarol}`,
  `  ${personalizedBob.text} / ${personalizedCarol.text}`,
  `ResolveScope (Resolver) injection — factory resolved its own deps imperatively: ${envReport.text}`,
  "=== HEADLINE: async — Promise<T>-only registration + recursive resolveAsync ===",
  `  resolveAsync<IRemoteConfig>() directly: ${remoteConfig.endpoint}`,
  `  resolveAsync<IRemoteConfigConsumer>() recursively resolved the bare token via the Promise<T> fallback: ${remoteConfigConsumer.describe()}`,
  `  RemoteConfig built exactly once — shared singleton cache through the async fallback: ${RemoteConfig.built === 1}`,
  "disposal — Symbol.dispose (sync) vs Symbol.asyncDispose (async):",
  `  sync dispose() tore down the sync-only scope: ${syncResourceA.disposed}`,
  `  disposeAsync() tore down both, REVERSE of construction order: ${disposalOrder[0]?.includes("async-resource") === true && disposalOrder[1]?.includes("sync-resource") === true}`,
  `  disposal log order: ${disposalOrder.join(" then ")}`,
  "last-wins override (registering a token twice — the engine keeps both, resolves the most recent):",
  `  bare IClock now resolves the override: ${overriddenClock instanceof OverrideClock} (${overriddenClock.now()})`,
  "=== HEADLINE: class-as-factory via OverloadedConstructorParameters ===",
  `  addFactory<I>(overload-faithful wrapper) resolves identically to add<I>(C): ${classReporter.report() === factoryReporter.report()} (both: "${factoryReporter.report()}")`,
  `  Reflect.construct really built a genuine Reporter: ${factoryReporter instanceof Reporter}`,
];

for (const line of lines) {
  console.log(line);
}
