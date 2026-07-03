// The abstractions smoke test: a LIBRARY that contributes DI registrations while
// depending on NOTHING at runtime.
//
// Its ONLY dependency is `@fnioc/core`, imported `import type` — the pure-types
// abstractions substrate. There is no `@fnioc/di` import: the library never
// builds a container, never opens a scope, never touches a runtime helper. It
// exposes a free function that a consuming APPLICATION calls with its own
// `@fnioc/di` `ServiceManifest`; di's manifest structurally satisfies core's
// authoring interface, so the wiring type-checks with zero runtime coupling.
//
// Signature slots are authored as PLAIN DATA LITERALS typed by core's `DepSlot`
// (`"token"`, `{ union: [...] }`) — the exact shapes the resolver matches. A lib
// author never imports `union(...)` / `typeArg(...)`; those are di-consumer sugar.

import type { ServiceManifest } from "@fnioc/core";

/** A clock the greeter reads the current time from. */
export interface IClock {
  now(): string;
}

/** Produces a greeting and returns it. */
export interface IGreeter {
  greet(name: string): string;
}

export class SystemClock implements IClock {
  public now(): string {
    return "2026-01-01T00:00:00Z";
  }
}

export class Greeter implements IGreeter {
  public constructor(private readonly clock: IClock) {}
  public greet(name: string): string {
    return `[${this.clock.now()}] Hello, ${name}!`;
  }
}

/**
 * The mandated free-function authoring pattern. `sc` is typed by `@fnioc/core`'s
 * authoring surface (`ServiceManifest`) — a lib author needs only the `.d.ts`.
 * The consuming application passes a real `@fnioc/di` manifest.
 *
 * @example
 * ```ts
 * import { ServiceManifest } from "@fnioc/di";
 * import { addClockServices } from "@fnioc-examples/abstractions-lib";
 *
 * const sc = new ServiceManifest<"singleton">();
 * addClockServices(sc);
 * const clock = sc.build().createScope("singleton").resolve<IClock>("lib:IClock");
 * ```
 */
export function addClockServices(sc: ServiceManifest<"singleton">): void {
  sc.add("lib:IClock", SystemClock).as("singleton");
  // A plain-literal union slot — the `{ union: [...] }` data IS the DepSlot the
  // resolver matches. The greeter's `clock` param resolves the first satisfiable
  // member (the primary clock; a backup token is offered as the fallback).
  sc.add("lib:IGreeter", Greeter, [
    [{ union: ["lib:IClock", "lib:IBackupClock"] }],
  ]).as("singleton");
}
