// The type-driven wiring + entry point.
//
// Registration is authored interface-first: `services.add<IGreeter>(Greeter)`
// carries no runtime token. At build time @fnioc/transformer rewrites each call
// to the string-token form `services.add("./contracts/IGreeter", Greeter)` and
// injects a `defineDeps(...)` prelude describing each class's constructor deps.
// Inspect `dist/main.js` after building to see the lowered output.
//
// The transformer lowers TOP-LEVEL `.add(...)` registration statements only, so
// every registration below sits at module scope. `resolve(...)` is NOT lowered,
// so the resolve calls use the same source-relative tokens the transformer
// emits for the registrations (`./contracts/I<Name>`).

import { DiBuilder } from "@fnioc/di";

import type {
  IClock,
  IGreeter,
  ILogger,
  IRequestId,
} from "./contracts.js";
import {
  ConsoleLogger,
  Greeter,
  RequestId,
  SystemClock,
} from "./services.js";

// `singleton` is the root (app-lifetime) scope; `request` is a child scope.
const services = new DiBuilder<"singleton", "request">();

services.add<ILogger>(ConsoleLogger).as<"singleton">();
services.add<IClock>(SystemClock).as<"singleton">();
services.add<IGreeter>(Greeter).as<"singleton">();
services.add<IRequestId>(RequestId).as<"request">();

const root = services.build();

// Resolve the greeter twice from the root scope. As a singleton it is the same
// instance both times, so the singleton logger it holds accumulates every line.
const greeterA = root.resolve<IGreeter>("./contracts/IGreeter");
const greeterB = root.resolve<IGreeter>("./contracts/IGreeter");

greeterA.greet("Ada");
greeterB.greet("Linus");

const logger = root.resolve<ILogger>("./contracts/ILogger");

// Two request child scopes, each owning its own request-scoped id. Resolving the
// id twice within one scope yields the same instance; a fresh scope yields a new
// one — proof of request-scoped lifetime via createScope().
const req1 = root.createScope("request");
const id1a = req1.resolve<IRequestId>("./contracts/IRequestId");
const id1b = req1.resolve<IRequestId>("./contracts/IRequestId");

const req2 = root.createScope("request");
const id2 = req2.resolve<IRequestId>("./contracts/IRequestId");

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
];

for (const line of lines) {
  console.log(line);
}
