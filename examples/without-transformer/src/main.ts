// The plugin-less wiring + entry point.
//
// This is the SAME app as ../../with-transformer, wired by hand. Without the
// transformer there is no type-driven authoring: every registration names an
// explicit string token, and every class with constructor dependencies needs
// its metadata registered manually — otherwise @fnioc/di throws
// MissingMetadataError at resolve time.
//
// Tokens are ours to choose; we use an `app/I<Name>` convention. The two things
// the transformer would have done automatically are done explicitly here:
//   1. `services.add("app/IGreeter", Greeter)` — the string token, written out.
//   2. `forCtor(Greeter).signature(...)` — the constructor dependency metadata.

import { DiBuilder, forCtor } from "@fnioc/di";

import {
  ConsoleLogger,
  Greeter,
  RequestId,
  SystemClock,
} from "./services.js";

// Our chosen tokens. The transformer would have derived source-relative ones
// (`./contracts/ILogger`); plugin-less, any stable string works.
const ILogger = "app/ILogger";
const IClock = "app/IClock";
const IGreeter = "app/IGreeter";
const IRequestId = "app/IRequestId";

// Hand-written dependency metadata. Greeter is the only class with ctor deps;
// its two parameters map positionally to the logger + clock tokens. The other
// classes are zero-arg, so they need no metadata. `forCtor(...).signature(...)`
// is the fluent equivalent of the `defineDeps(Greeter, [[ILogger, IClock]])`
// the transformer emits.
forCtor(Greeter).signature(ILogger, IClock);

// `singleton` is the root (app-lifetime) scope; `request` is a child scope.
const services = new DiBuilder<"singleton", "request">();

services.add(ILogger, ConsoleLogger).as("singleton");
services.add(IClock, SystemClock).as("singleton");
services.add(IGreeter, Greeter).as("singleton");
services.add(IRequestId, RequestId).as("request");

const root = services.build();

// Resolve the greeter twice from the root scope. As a singleton it is the same
// instance both times, so the singleton logger it holds accumulates every line.
const greeterA = root.resolve<Greeter>(IGreeter);
const greeterB = root.resolve<Greeter>(IGreeter);

greeterA.greet("Ada");
greeterB.greet("Linus");

const logger = root.resolve<ConsoleLogger>(ILogger);

// Two request child scopes, each owning its own request-scoped id. Resolving the
// id twice within one scope yields the same instance; a fresh scope yields a new
// one — proof of request-scoped lifetime via createScope().
const req1 = root.createScope("request");
const id1a = req1.resolve<RequestId>(IRequestId);
const id1b = req1.resolve<RequestId>(IRequestId);

const req2 = root.createScope("request");
const id2 = req2.resolve<RequestId>(IRequestId);

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
];

for (const line of lines) {
  console.log(line);
}
