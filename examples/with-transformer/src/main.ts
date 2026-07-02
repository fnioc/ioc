// The type-driven wiring + entry point.
//
// The contracts and service CLASSES live in `@fnioc-examples/shared` — imported
// below via a relative source path so `tspc` compiles them into this example's
// own `dist`. The ONLY thing this file adds over the without-transformer example
// is the WIRING STYLE: registration is authored interface-first
// (`services.add<IGreeter>(Greeter)`, no runtime token), resolution is tokenless
// (`resolve<IGreeter>()`), and open generics use `$<N>` / `Typeof<T>`
// placeholders. At build time @fnioc/transformer rewrites each call to its
// explicit-token form and injects the `defineDeps(...)` prelude. Inspect
// `dist/with-transformer/src/main.js` after building to see the lowered output.
//
// The transformer lowers TOP-LEVEL `.add(...)` / `.resolve(...)` statements, so
// every registration and resolve below sits at module scope or reads a
// module-scope binding.

import { type $, ServiceManifest } from "@fnioc/di";
import "@fnioc/transformer";

import type {
  IAuditor,
  IClock,
  IDiagnosticsService,
  IGreeter,
  ILogger,
  IMetricsBackend,
  IRepository,
  IRequestId,
} from "../../shared/src/index.js";
import {
  ConsoleLogger,
  DiagnosticsService,
  Greeter,
  InMemoryMetrics,
  InMemoryRepository,
  Invoice,
  Order,
  RepositoryAuditor,
  RequestId,
  SqlRepository,
  SystemClock,
  UnionConsumer,
  User,
} from "../../shared/src/index.js";

// `singleton` and `request` are the two scope tags this app opens. There is no
// root: scopes are uniform tags, and `singleton` is just the one we open once at
// the top (below, via `createScope("singleton")`) for app-lifetime instances.
const services = new ServiceManifest<"singleton" | "request">();

services.add<ILogger>(ConsoleLogger).as<"singleton">();
services.add<IClock>(SystemClock).as<"singleton">();
services.add<IGreeter>(Greeter).as<"singleton">();
services.add<IRequestId>(RequestId).as<"request">();
services.add<IMetricsBackend>(InMemoryMetrics).as<"singleton">();

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

// Two request child scopes, each owning its own request-scoped id.
const req1 = root.createScope("request");
const id1a = req1.resolve<IRequestId>();
const id1b = req1.resolve<IRequestId>();

const req2 = root.createScope("request");
const id2 = req2.resolve<IRequestId>();

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
];

for (const line of lines) {
  console.log(line);
}
