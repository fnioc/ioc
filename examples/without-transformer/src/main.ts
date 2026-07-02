// The plugin-less wiring + entry point.
//
// This is the SAME app as ../../with-transformer, wired by hand. It imports the
// IDENTICAL contracts + service classes from `@fnioc-examples/shared` (via a
// relative source path, so plain `tsc` compiles them into this example's own
// `dist`). Diff this file against the with-transformer main.ts and the ONLY
// difference is the WIRING STYLE: without the transformer there is no type-driven
// authoring — every registration names an explicit string token, every class
// with ctor dependencies has its metadata written by hand (`forCtor`), and open
// generics are closed manually with `closeToken` / `typeArg`.

import { closeToken, forCtor, ServiceManifest, typeArg, union } from "@fnioc/di";

import type { IAuditor, IRepository } from "../../shared/src/index.js";
import {
  ConsoleLogger,
  DiagnosticsService,
  Greeter,
  InMemoryMetrics,
  InMemoryRepository,
  RepositoryAuditor,
  RequestId,
  SqlRepository,
  SystemClock,
  UnionConsumer,
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

// Hand-written dependency metadata — the `forCtor(...).signature(...)` fluent
// equivalent of the `defineDeps(...)` the transformer would emit. Greeter's two
// params map positionally to the logger + clock tokens.
forCtor(Greeter).signature(LOGGER, CLOCK);

// Union slot: UnionConsumer's `sink` accepts either LOGGER or METRICS. Members
// are tried in declaration order; LOGGER is registered, so it wins.
forCtor(UnionConsumer).signature(union(LOGGER, METRICS));

// The Inject brand replicated by hand: DiagnosticsService's `clock` param pins
// PRIMARY_CLOCK (the with-transformer example derives this automatically).
forCtor(DiagnosticsService).signature(PRIMARY_CLOCK, LOGGER);

// `singleton` and `request` are the two scope tags this app opens. There is no
// root: scopes are uniform tags, and `singleton` is just the one we open once at
// the top (below, via `createScope("singleton")`) for app-lifetime instances.
const services = new ServiceManifest<"singleton" | "request">();

services.add(LOGGER, ConsoleLogger).as("singleton");
services.add(CLOCK, SystemClock).as("singleton");
services.add(GREETER, Greeter).as("singleton");
services.add(REQUEST_ID, RequestId).as("request");
services.add(METRICS, InMemoryMetrics).as("singleton");
services.add(UNION_CONSUMER, UnionConsumer).as("singleton");
services.add(PRIMARY_CLOCK, SystemClock);
services.add(DIAGNOSTICS, DiagnosticsService).as("singleton");

// Open template registration: the third `add` argument carries the dep
// signatures ON the registration (a generic class can't use the ctor-keyed store
// across closings — one erased class would collide). `typeArg(1)` is the witness
// slot: at each closing it becomes the type argument's token string.
// `.as("singleton")` applies PER CLOSING — the closings are distinct singletons.
services.add(REPOSITORY_TEMPLATE, SqlRepository, [[LOGGER, typeArg(1)]]).as("singleton");

// A CLOSED (exact) registration for one entity — beats the open fallback for
// that closing. Its `Typeof<T>` witness is supplied as a literal value slot.
services.add(closeToken(REPOSITORY, ORDER), InMemoryRepository, [[{ value: ORDER }]]).as("singleton");

// The forCtor alternative for a generic-on-generic: a HOLE template in the
// ctor-keyed store. The auditor's dep template `app/IRepository<$1>` is
// substituted per closing — resolving `app/IAuditor<app/User>` wires in the
// User repository closing.
forCtor(RepositoryAuditor).signature(REPOSITORY_TEMPLATE);
services.add(AUDITOR_TEMPLATE, RepositoryAuditor).as("singleton");

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

// Union demo: UnionConsumer resolved to ILogger (first in union, registered).
const unionConsumer = root.resolve<UnionConsumer>(UNION_CONSUMER);
unionConsumer.emit("union-test");

// Inject demo: DiagnosticsService's clock pinned to PRIMARY_CLOCK by hand.
const diag = root.resolve<DiagnosticsService>(DIAGNOSTICS);
const diagResult = diag.diagnose();

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

// The auditor's forCtor hole template closes recursively: its repo dep is the
// SAME instance as the User repository closing above.
const auditor = root.resolve<IAuditor<unknown>>(closeToken(AUDITOR, USER));

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
  "open generics:",
  `  user repo is a per-closing singleton: ${userRepo === userRepoAgain}`,
  `  distinct closings are distinct instances: ${userRepo !== invoiceRepo}`,
  `  user save: ${userSave}`,
  `  invoice save: ${invoiceSave}`,
  `  SqlRepository instances built: ${SqlRepository.built}`,
  `  closed registration wins for Order: ${orderRepo.kind}`,
  `  order save: ${orderSave}`,
  `  auditor closed over the user repo: ${auditor.repo === userRepo} (${auditor.audit()})`,
];

for (const line of lines) {
  console.log(line);
}
