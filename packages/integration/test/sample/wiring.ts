// The type-driven wiring surface — the form the transformer lowers FROM.
//
// `services.add<I>(C).as<"tag">()` carries no runtime token; the transformer
// rewrites each call to the string-token `.add("token", C).as("tag")` form and
// injects a `defineDeps(C, [...])` for every constructed class. The transformer
// only lowers TOP-LEVEL registration statements (it walks `sourceFile.statements`),
// so every `.add(...)` here sits at module scope. This module is compiled WITH
// the plugin in the ABI / factory / overload tests; its behaviour is reproduced
// WITHOUT the plugin (hand-fed tokens) in the parity test.

import { DiBuilder } from "@fnioc/di";
import type {
  IConfig,
  IConfigConsumer,
  IDbConnection,
  ILogger,
  IReport,
  IReportService,
  IRequestContext,
  IThunk,
  IThunkConsumer,
  IUserRepo,
} from "./contracts.js";
import {
  ConfigConsumer,
  ConsoleLogger,
  Report,
  ReportService,
  RequestContext,
  SqlDb,
  SqlUserRepo,
  ThunkConsumer,
} from "./services.js";

export type SampleScopes = "singleton" | "request";

/** The token the di engine uses for the async config registration. */
export const CONFIG_TOKEN = "./sample/contracts/IConfig";

/** The token the di engine uses for the named-callable IThunk service. */
export const THUNK_TOKEN = "./sample/contracts/IThunk";

/** The single shared IThunk value the opt-out test resolves (a callable). */
export const theThunk: IThunk = () => "thunk-result";

/**
 * The async config factory — returns a `Promise<IConfig>`. Async-ness is a
 * property of the registration, not a token: the engine never awaits, the
 * Promise flows through as a value, and the consumer declares `Promise<IConfig>`.
 */
export let configFactoryRuns = 0;
export function resetConfigFactoryRuns(): void {
  configFactoryRuns = 0;
}
export function makeConfig(): Promise<IConfig> {
  configFactoryRuns += 1;
  return Promise.resolve({ endpoint: "https://db.example/api" });
}

export const services = new DiBuilder<SampleScopes>();

// Type-driven registrations — TOP-LEVEL so the transformer lowers each type arg
// to a string token and injects a `defineDeps(C, [...])` prelude per class.
services.add<ILogger>(ConsoleLogger).as<"singleton">();
services.add<IDbConnection>(SqlDb).as<"singleton">();
services.add<IUserRepo>(SqlUserRepo).as<"request">();
services.add<IRequestContext>(RequestContext).as<"request">();
services.add<IReport>(Report).as<"request">();
services.add<IThunkConsumer>(ThunkConsumer).as<"singleton">();
services.add<IConfigConsumer>(ConfigConsumer).as<"singleton">();

// ReportService holds two inline factory params. The transformer detects
// `() => IUserRepo` + `(ctx) => IReport` and emits `{ factory }` slots. It is
// REQUEST-scoped: its factory closures are owned by the request scope, so the
// request-scoped targets they build resolve correctly (§5.4 — a singleton
// holding these factories would fail when invoked, which is the captive rule).
services.add<IReportService>(ReportService).as<"request">();

// Plugin-less path: async config via a Promise-returning factory, cached as a
// singleton. This same closure is used identically in the parity test.
services.register<Promise<IConfig>>(CONFIG_TOKEN, {
  useFactory: () => makeConfig(),
  tag: "singleton",
});

// The named-callable IThunk is provided plugin-less as a value (it is a plain
// closure, not a class). ThunkConsumer's `IThunk` ctor param lowers to this
// token — a plain string slot, NOT a factory — so di resolves THIS value.
services.register<IThunk>(THUNK_TOKEN, { useValue: theThunk });
