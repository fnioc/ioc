import { test, expect, describe } from "bun:test";
import { ServiceManifest, AsyncDisposalRequiredError } from "@fnioc/di";
import {
  DisposeLog,
  SyncDisposable,
  AsyncDisposableThing,
  NonDisposable,
  T,
} from "./fixtures.js";

// Disposal (native TC39 Disposable / AsyncDisposable only): a scope tracks owned
// instances in construction order and disposes them in REVERSE on close.
// Sync dispose() throws if the scope owns a Promise-valued instance.

describe("sync disposal", () => {
  test("disposes owned instances in reverse construction order", () => {
    const log = new DisposeLog();
    const services = new ServiceManifest<"singleton">();
    services.addFactory(T.A, () => new SyncDisposable("A", log)).as("singleton");
    services.addFactory(T.B, () => new SyncDisposable("B", log)).as("singleton");
    services.addFactory(T.C, () => new SyncDisposable("C", log)).as("singleton");

    const root = services.build().createScope("singleton");
    root.resolve(T.A); // constructed first
    root.resolve(T.B);
    root.resolve(T.C); // constructed last
    root.dispose();

    // Reverse of construction order: C, B, A.
    expect(log.order).toEqual(["C", "B", "A"]);
  });

  test("only native Disposable instances are disposed; others untouched", () => {
    const log = new DisposeLog();
    const plain = new NonDisposable("plain");
    const services = new ServiceManifest<"singleton">();
    services.addFactory(T.A, () => new SyncDisposable("A", log)).as("singleton");
    services.addFactory(T.B, () => plain).as("singleton");

    const root = services.build().createScope("singleton");
    const a = root.resolve<SyncDisposable>(T.A);
    root.resolve(T.B);
    root.dispose();

    expect(a.disposed).toBe(true);
    expect(log.order).toEqual(["A"]); // the non-disposable contributed nothing
  });

  test("a child scope's dispose does NOT dispose ancestor-owned instances", () => {
    const log = new DisposeLog();
    const services = new ServiceManifest<"singleton" | "request">();
    services.addFactory(T.A, () => new SyncDisposable("singleton-A", log)).as("singleton");
    services.addFactory(T.B, () => new SyncDisposable("request-B", log)).as("request");

    const root = services.build().createScope("singleton");
    const req = root.createScope("request");
    req.resolve(T.A); // owned by root
    req.resolve(T.B); // owned by req

    req.dispose();
    expect(log.order).toEqual(["request-B"]); // only req's own instance

    root.dispose();
    expect(log.order).toEqual(["request-B", "singleton-A"]);
  });

  test("dispose is idempotent — a second call is a no-op", () => {
    const log = new DisposeLog();
    const services = new ServiceManifest<"singleton">();
    services.addFactory(T.A, () => new SyncDisposable("A", log)).as("singleton");

    const root = services.build().createScope("singleton");
    root.resolve(T.A);
    root.dispose();
    root.dispose();
    expect(log.order).toEqual(["A"]); // disposed exactly once
  });

  test("transient (uncached) instances are NOT tracked for disposal", () => {
    const log = new DisposeLog();
    const services = new ServiceManifest<"singleton">();
    services.addFactory(T.A, () => new SyncDisposable("transient", log));
    // no .as() ⇒ transient, never cached, never owned

    const root = services.build();
    root.resolve(T.A);
    root.dispose();
    expect(log.order).toEqual([]); // nothing owned ⇒ nothing disposed
  });
});

describe("async disposal", () => {
  test("disposes AsyncDisposable instances in reverse construction order", async () => {
    const log = new DisposeLog();
    const services = new ServiceManifest<"singleton">();
    services.addFactory(T.A, () => new AsyncDisposableThing("A", log)).as("singleton");
    services.addFactory(T.B, () => new AsyncDisposableThing("B", log)).as("singleton");

    const root = services.build().createScope("singleton");
    root.resolve(T.A);
    root.resolve(T.B);
    await root.disposeAsync();

    expect(log.order).toEqual(["B", "A"]);
  });

  test("disposeAsync honors both Symbol.dispose and Symbol.asyncDispose", async () => {
    const log = new DisposeLog();
    const services = new ServiceManifest<"singleton">();
    services.addFactory(T.A, () => new SyncDisposable("sync", log)).as("singleton");
    services.addFactory(T.B, () => new AsyncDisposableThing("async", log)).as("singleton");

    const root = services.build().createScope("singleton");
    root.resolve(T.A);
    root.resolve(T.B);
    await root.disposeAsync();

    // Reverse order, mixed disposers both fire.
    expect(log.order).toEqual(["async", "sync"]);
  });

  test("disposeAsync awaits Promise-valued instances before disposing them", async () => {
    const log = new DisposeLog();
    const services = new ServiceManifest<"singleton">();
    services.addFactory(T.A, async () => new AsyncDisposableThing("resolved", log)).as("singleton");

    const root = services.build().createScope("singleton");
    root.resolve<Promise<AsyncDisposableThing>>(T.A);
    await root.disposeAsync();

    // The Promise was awaited, then the settled disposable was disposed.
    expect(log.order).toEqual(["resolved"]);
  });
});

describe("sync dispose with a Promise-valued instance", () => {
  test("throws AsyncDisposalRequiredError directing to disposeAsync", () => {
    const services = new ServiceManifest<"singleton">();
    services.addFactory(T.A, async () => ({ ok: true })).as("singleton");

    const root = services.build().createScope("singleton");
    root.resolve(T.A); // caches a Promise

    expect(() => root.dispose()).toThrow(AsyncDisposalRequiredError);
    try {
      root.dispose();
    } catch (err) {
      expect((err as Error).message).toContain("disposeAsync");
    }
  });

  test("after the throw, disposeAsync still cleans up correctly", async () => {
    const log = new DisposeLog();
    const services = new ServiceManifest<"singleton">();
    services.addFactory(T.A, async () => new AsyncDisposableThing("late", log)).as("singleton");

    const root = services.build().createScope("singleton");
    root.resolve(T.A);
    expect(() => root.dispose()).toThrow(AsyncDisposalRequiredError);

    // dispose() threw before flipping the disposed flag, so disposeAsync still
    // runs the teardown.
    await root.disposeAsync();
    expect(log.order).toEqual(["late"]);
  });
});

describe("native using / await using", () => {
  test("using calls Symbol.dispose on block exit", () => {
    const log = new DisposeLog();
    const services = new ServiceManifest<"singleton">();
    services.addFactory(T.A, () => new SyncDisposable("scoped", log)).as("singleton");
    const root = services.build();

    {
      using child = root.createScope("singleton");
      // resolve on the child's own scope so it owns the instance.
      child.resolve(T.A);
      expect(log.order).toEqual([]);
    }
    // child disposed on block exit.
    expect(log.order).toEqual(["scoped"]);
  });

  test("await using calls Symbol.asyncDispose on block exit", async () => {
    const log = new DisposeLog();
    const services = new ServiceManifest<"singleton" | "request">();
    services.addFactory(T.A, () => new AsyncDisposableThing("req", log)).as("request");
    const root = services.build();

    {
      await using req = root.createScope("request");
      req.resolve(T.A);
      expect(log.order).toEqual([]);
    }
    expect(log.order).toEqual(["req"]);
  });
});
