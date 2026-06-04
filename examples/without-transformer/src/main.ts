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
//
// This file also demonstrates two additional manual-surface features:
//   3. `union("tok:A", "tok:B")` — a slot with alternatives (first resolvable wins).
//   4. `forCtor(ThirdParty).signature(...)` — complete manual signature for a
//      class you do not own (no @signature decorator, no transformer).

import { ServiceManifest, forCtor, union } from "@fnioc/di";

import {
  ConsoleLogger,
  DiagnosticsReporter,
  Greeter,
  RequestId,
  SystemClock,
  ThirdPartyFormatter,
} from "./services.js";

// Our chosen tokens. The transformer would have derived source-relative ones
// (`./contracts/ILogger`); plugin-less, any stable string works.
const LOGGER = "app/ILogger";
const CLOCK = "app/IClock";
const GREETER = "app/IGreeter";
const REQUEST_ID = "app/IRequestId";
const DIAGNOSTICS_REPORTER = "app/IDiagnosticsReporter";
const THIRD_PARTY_FORMATTER = "app/IThirdPartyFormatter";

// Hand-written dependency metadata. Greeter is the only class with ctor deps
// from the core example; its two parameters map positionally to the logger +
// clock tokens. `forCtor(...).signature(...)` is the fluent equivalent of the
// `defineDeps(Greeter, [[LOGGER, CLOCK]])` the transformer emits.
forCtor(Greeter).signature(LOGGER, CLOCK);

// Union slot: DiagnosticsReporter accepts either LOGGER or CLOCK as its sink.
// The `union(...)` helper builds a { union: [...] } DepSlot. Members are tried
// in declaration order; the first registered one wins. Since LOGGER IS registered,
// it resolves to the logger.
forCtor(DiagnosticsReporter).signature(union(LOGGER, CLOCK));

// Third-party class: ThirdPartyFormatter is a class we do not own — there is no
// @signature decorator and the transformer is not running. `forCtor(...).signature(...)`
// supplies the complete ctor signature manually, exactly as the transformer would
// have emitted via defineDeps.
forCtor(ThirdPartyFormatter).signature(LOGGER, CLOCK);

// `singleton` and `request` are the two scope tags this app opens. There is no
// root: scopes are uniform tags, and `singleton` is just the one we open once at
// the top (below, via `createScope("singleton")`) for app-lifetime instances.
const services = new ServiceManifest<"singleton" | "request">();

services.add(LOGGER, ConsoleLogger).as("singleton");
services.add(CLOCK, SystemClock).as("singleton");
services.add(GREETER, Greeter).as("singleton");
services.add(REQUEST_ID, RequestId).as("request");
services.add(DIAGNOSTICS_REPORTER, DiagnosticsReporter).as("singleton");
services.add(THIRD_PARTY_FORMATTER, ThirdPartyFormatter).as("singleton");

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

// Union demo: DiagnosticsReporter resolved to ILogger (first in union, registered).
const reporter = root.resolve<DiagnosticsReporter>(DIAGNOSTICS_REPORTER);
reporter.report("startup");

// Third-party class demo: ThirdPartyFormatter wired via complete manual signature.
const formatter = root.resolve<ThirdPartyFormatter>(THIRD_PARTY_FORMATTER);
const formatted = formatter.format("demo message");

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
  `union resolved to logger (first member): ${reporter.sink === logger}`,
  `third-party formatter wired: ${formatted.startsWith("[2026-01-01")}`,
];

for (const line of lines) {
  console.log(line);
}
