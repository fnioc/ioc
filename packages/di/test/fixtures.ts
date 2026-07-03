// Shared test fixtures. The tests hand-feed dep metadata (NO transformer) — the
// engine only ever sees string tokens and positional signatures, exactly as it
// would post-lowering.
//
// The global metadata store is retired: signatures now ride ON the registration
// (`add(token, ctor, [[...]])`). To keep the plentiful `defineDeps(C, sig); …
// add(tok, C)` fixtures readable, this module provides a TEST-ONLY ergonomic:
// `defineDeps`/`forCtor` stash signatures in a per-process WeakMap, and
// `ServiceManifestClass.prototype.add`/`.addFactory` are patched to thread a
// stashed signature in as the third argument when a call passes only
// `(token, target)`. The engine still sees exactly `registration.signatures` —
// this is pure authoring sugar over the inline third-argument form.

import { ServiceManifestClass } from "@fnioc/di";
import type { DepSlot, Token } from "@fnioc/core";

type Signatures = readonly (readonly DepSlot[])[];

/** The test-only signature stash — keyed by the ctor / factory function. */
const testStore = new WeakMap<object, DepSlot[][]>();

/** Stash one-or-more signatures for `target`, appending to any prior stash. */
export function defineDeps(target: object, signatures: Signatures): void {
  const copies = signatures.map((sig) => [...sig]);
  const existing = testStore.get(target);
  if (existing !== undefined) {
    existing.push(...copies);
  } else {
    testStore.set(target, copies);
  }
}

/** Reads back a stashed record — mirrors the retired `getDeps` for assertions. */
export function getDeps(target: object): { signatures: Signatures } | undefined {
  const signatures = testStore.get(target);
  return signatures === undefined ? undefined : { signatures };
}

/** Chainable fluent stash — one `.signature(...)` call per overload. */
export interface ForCtorBuilder {
  signature(...slots: DepSlot[]): ForCtorBuilder;
}
export function forCtor(ctor: object): ForCtorBuilder {
  const builder: ForCtorBuilder = {
    signature(...slots: DepSlot[]): ForCtorBuilder {
      defineDeps(ctor, [slots]);
      return builder;
    },
  };
  return builder;
}

// Patch `add` / `addFactory` to thread a stashed signature into the third-arg
// channel when the caller passed only `(token, target)`. A no-op when the target
// has no stash or a signature was passed explicitly.
type AddFn = (...args: unknown[]) => unknown;
function patchThirdArg(method: "add" | "addFactory"): void {
  const proto = ServiceManifestClass.prototype as unknown as Record<string, AddFn>;
  const original = proto[method]!;
  proto[method] = function (this: unknown, ...args: unknown[]): unknown {
    const target = args[1];
    if (
      args.length === 2 &&
      typeof args[0] === "string" &&
      (typeof target === "object" || typeof target === "function") &&
      target !== null
    ) {
      const stashed = testStore.get(target);
      if (stashed !== undefined) {
        return original.call(this, args[0], target, stashed);
      }
    }
    return original.apply(this, args);
  };
}
patchThirdArg("add");
patchThirdArg("addFactory");

// ── Tokens ──────────────────────────────────────────────────────────────────

export const T = {
  Logger: "pkg:ILogger" as Token,
  Db: "pkg:IDb" as Token,
  Repo: "pkg:IRepo" as Token,
  Service: "pkg:IService" as Token,
  Config: "pkg:IConfig" as Token,
  A: "pkg:IA" as Token,
  B: "pkg:IB" as Token,
  C: "pkg:IC" as Token,
} as const;

/** Generic-token fixtures for the open-generics suite. */
export const G = {
  RepoTemplate: "pkg:IRepo<$1>" as Token,
  RepoOfA: "pkg:IRepo<pkg:IA>" as Token,
  RepoOfB: "pkg:IRepo<pkg:IB>" as Token,
} as const;

// ── Counters ────────────────────────────────────────────────────────────────

/** A construction counter so tests can assert how many times a ctor ran. */
export function makeCounter(): { count: number; bump(): void } {
  const state = { count: 0, bump() {} };
  state.bump = () => {
    state.count += 1;
  };
  return state;
}

// ── Disposal probes ─────────────────────────────────────────────────────────

/** Records dispose order across instances into a shared array. */
export class DisposeLog {
  public readonly order: string[] = [];
}

/** A native `Disposable` that appends its label to a shared log on dispose. */
export class SyncDisposable implements Disposable {
  public disposed = false;
  public constructor(
    public readonly label: string,
    private readonly log: DisposeLog,
  ) {}
  public [Symbol.dispose](): void {
    this.disposed = true;
    this.log.order.push(this.label);
  }
}

/** A native `AsyncDisposable` that appends its label on async dispose. */
export class AsyncDisposableThing implements AsyncDisposable {
  public disposed = false;
  public constructor(
    public readonly label: string,
    private readonly log: DisposeLog,
  ) {}
  public async [Symbol.asyncDispose](): Promise<void> {
    await Promise.resolve();
    this.disposed = true;
    this.log.order.push(this.label);
  }
}

/** A plain object with no disposal contract — must be left untouched. */
export class NonDisposable {
  public constructor(public readonly label: string) {}
}

// ── Plain classes ───────────────────────────────────────────────────────────

/** Zero-arg constructor — `new`ed directly, no dep lookup. */
export class ZeroArg {
  public readonly tag = "zero";
}

/**
 * A class with one dependency. Annotate with `defineDeps(OneDep, [[token]])`
 * before registering.
 */
export class OneDep {
  public constructor(public readonly dep: unknown) {}
}

/** A class whose ctor has params but is intentionally left un-annotated. */
export class Unannotated {
  public constructor(public readonly a: unknown) {}
}

