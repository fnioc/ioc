// The type-driven wiring + entry point.
//
// Registration is authored interface-first: `services.add<IGreeter>(Greeter)`
// carries no runtime token. At build time @fnioc/transformer rewrites each call
// to the string-token form `services.add("./contracts/IGreeter", Greeter)` and
// injects a `defineDeps(...)` prelude describing each class's constructor deps.
// Inspect `dist/main.js` after building to see the lowered output.
//
// This file also demonstrates:
//   - Inject<T, "tok"> (§3) — pins a specific token for one ctor param (DiagnosticsService)
//   - Inline union (§8)     — `A | B` ctor param lowers to a union slot (UnionConsumer)
//
// The transformer lowers TOP-LEVEL `.add(...)` registration statements only, so
// every registration below sits at module scope.

import { DiBuilder } from "@fnioc/di";

import type {
  IClock,
  IDiagnosticsService,
  IGreeter,
  ILogger,
  IMetricsBackend,
  IRequestId,
} from "./contracts.js";
import {
  ConsoleLogger,
  DiagnosticsService,
  Greeter,
  InMemoryMetrics,
  RequestId,
  SystemClock,
  UnionConsumer,
} from "./services.js";

// `singleton` is the root (app-lifetime) scope; `request` is a child scope.
const services = new DiBuilder<"singleton", "request">();

services.add<ILogger>(ConsoleLogger).as<"singleton">();
services.add<IClock>(SystemClock).as<"singleton">();
services.add<IGreeter>(Greeter).as<"singleton">();
services.add<IRequestId>(RequestId).as<"request">();
services.add<IMetricsBackend>(InMemoryMetrics).as<"singleton">();

// Inline-union demo: UnionConsumer takes `ILogger | IMetricsBackend`. The
// transformer emits a union slot; ILogger is declared first so it wins.
services.add<UnionConsumer>(UnionConsumer).as<"singleton">();

// Inject brand demo: DiagnosticsService's `clock` param is branded
// `Inject<IClock, "app:primary-clock">`. The transformer uses `"app:primary-clock"`
// as the token for that param. We register SystemClock under this token so the
// resolution succeeds. The `logger` param uses normal structural derivation.
services.add("app:primary-clock", SystemClock);
services.add<IDiagnosticsService>(DiagnosticsService).as<"singleton">();

const root = services.build();

// Resolve the greeter twice from the root scope. As a singleton it is the same
// instance both times, so the singleton logger it holds accumulates every line.
const greeterA = root.resolve<IGreeter>("./contracts/IGreeter");
const greeterB = root.resolve<IGreeter>("./contracts/IGreeter");

greeterA.greet("Ada");
greeterB.greet("Linus");

const logger = root.resolve<ILogger>("./contracts/ILogger");

// Two request child scopes, each owning its own request-scoped id.
const req1 = root.createScope("request");
const id1a = req1.resolve<IRequestId>("./contracts/IRequestId");
const id1b = req1.resolve<IRequestId>("./contracts/IRequestId");

const req2 = root.createScope("request");
const id2 = req2.resolve<IRequestId>("./contracts/IRequestId");

// Union demo: UnionConsumer resolved to ILogger (first in union, registered).
// Token is derived from the class itself (in services.ts), not an interface.
const unionConsumer = root.resolve<UnionConsumer>("./services/UnionConsumer");
unionConsumer.emit("union-test");

// Inject demo: DiagnosticsService registered under IDiagnosticsService's token.
const diag = root.resolve<IDiagnosticsService>("./contracts/IDiagnosticsService");
const diagResult = diag.diagnose();

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
];

for (const line of lines) {
  console.log(line);
}
