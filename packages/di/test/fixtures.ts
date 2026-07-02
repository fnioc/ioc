// Shared test fixtures. The tests hand-feed dep metadata via `defineDeps`
// (NO transformer) — the engine only ever sees string tokens and positional
// signatures, exactly as it would post-lowering.

import { defineDeps } from "@fnioc/core";
import type { Token } from "@fnioc/core";

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

/** Re-export for convenience in tests that build metadata inline. */
export { defineDeps };
