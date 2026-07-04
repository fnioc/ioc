import { test, expect, describe } from "bun:test";
import { ServiceManifest, AsyncDisposalRequiredError } from "@fnioc/di";
import { defineDeps } from "../../di/test/metadata-shim.js";

// Coverage 6 (disposal — sync), 7 (disposal — async), 8 (async-as-values).
//
// Disposal order is REVERSE construction order; sync `dispose()` refuses a scope
// owning a Promise-valued instance (it cannot settle it synchronously) and
// directs to `disposeAsync()`. Async disposal awaits Promise-valued instances
// first, then disposes honoring `Symbol.asyncDispose` / `Symbol.dispose`. The
// async-as-values path proves a `useFactory` returning `Promise<T>` is cached as
// a singleton Promise that runs the factory once and yields one instance.

// ── Coverage 6: sync disposal ─────────────────────────────────────────────────

describe("sync disposal — reverse construction order", () => {
  test("closing a scope disposes owned Disposable instances in reverse order", () => {
    const order: string[] = [];

    class First implements Disposable {
      public [Symbol.dispose](): void {
        order.push("First");
      }
    }
    class Second implements Disposable {
      // Constructed AFTER First (it depends on it), so disposed BEFORE it.
      public constructor(public readonly first: First) {}
      public [Symbol.dispose](): void {
        order.push("Second");
      }
    }
    defineDeps(First, [[]]);
    defineDeps(Second, [["d:first"]]);

    const services = new ServiceManifest<"app">();
    services.add("d:first", First).as("app");
    services.add("d:second", Second).as("app");

    const root = services.build().createScope("app");
    root.resolve("d:second"); // constructs First then Second

    root.dispose();
    // Reverse construction order: Second (built last) disposed first.
    expect(order).toEqual(["Second", "First"]);
  });

  test("sync dispose() throws AsyncDisposalRequiredError when the scope owns a Promise", () => {
    const services = new ServiceManifest<"app">();
    // addFactory (no defineDeps record) → engine calls factory(scope); returns a
    // Promise which is cached on the "app" scope and triggers the async-disposal guard.
    services.addFactory("async:value", () => Promise.resolve({ ready: true })).as("app");

    const root = services.build().createScope("app");
    root.resolve("async:value"); // caches the Promise on the root

    let caught: unknown;
    try {
      root.dispose();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AsyncDisposalRequiredError);
    expect((caught as Error).message).toContain("disposeAsync()");
  });

  test("dispose() is idempotent — a second call is a no-op", () => {
    let disposals = 0;
    class Thing implements Disposable {
      public [Symbol.dispose](): void {
        disposals += 1;
      }
    }
    defineDeps(Thing, [[]]);

    const services = new ServiceManifest<"app">();
    services.add("d:thing", Thing).as("app");
    const root = services.build().createScope("app");
    root.resolve("d:thing");

    root.dispose();
    root.dispose();
    expect(disposals).toBe(1);
  });
});

// ── Coverage 7: async disposal ────────────────────────────────────────────────

describe("async disposal — awaits Promise-valued instances, reverse order", () => {
  test("disposeAsync handles AsyncDisposable + Disposable in reverse construction order", async () => {
    const order: string[] = [];

    class AsyncFirst implements AsyncDisposable {
      public async [Symbol.asyncDispose](): Promise<void> {
        await Promise.resolve();
        order.push("AsyncFirst");
      }
    }
    class SyncSecond implements Disposable {
      public constructor(public readonly first: AsyncFirst) {}
      public [Symbol.dispose](): void {
        order.push("SyncSecond");
      }
    }
    defineDeps(AsyncFirst, [[]]);
    defineDeps(SyncSecond, [["a:first"]]);

    const services = new ServiceManifest<"app">();
    services.add("a:first", AsyncFirst).as("app");
    services.add("a:second", SyncSecond).as("app");

    const root = services.build().createScope("app");
    root.resolve("a:second"); // AsyncFirst then SyncSecond

    await root.disposeAsync();
    // Reverse order, honoring both disposal protocols.
    expect(order).toEqual(["SyncSecond", "AsyncFirst"]);
  });

  test("disposeAsync awaits a Promise-valued instance and disposes its settled value", async () => {
    const disposed: string[] = [];

    class Resource implements AsyncDisposable {
      public async [Symbol.asyncDispose](): Promise<void> {
        disposed.push("Resource");
      }
    }

    const services = new ServiceManifest<"app">();
    // addFactory (no defineDeps record) → called with the live scope; returns a
    // Promise<Resource> cached on "app" — disposeAsync awaits it then disposes.
    services.addFactory("a:resource", () => Promise.resolve(new Resource())).as("app");

    const root = services.build().createScope("app");
    const p = root.resolve<Promise<Resource>>("a:resource");
    expect(p).toBeInstanceOf(Promise);

    await root.disposeAsync();
    // The Promise was awaited first, then its settled Resource disposed.
    expect(disposed).toEqual(["Resource"]);
  });
});

// ── Coverage 8: async-as-values ───────────────────────────────────────────────

describe("async as values — Promise<T> useFactory cached as a singleton Promise", () => {
  test("a singleton caches the SAME Promise; the factory runs once; awaiting twice → one instance", async () => {
    let runs = 0;
    class Db {
      public readonly id: number;
      public constructor() {
        this.id = ++Db.counter;
      }
      public static counter = 0;
    }

    const services = new ServiceManifest<"singleton">();
    // addFactory (no defineDeps record) → called with scope; factory ignores it
    // and returns the Promise. Cached as a singleton Promise (runs once).
    services.addFactory("av:db", () => {
      runs += 1;
      return Promise.resolve(new Db());
    }).as("singleton");

    const root = services.build().createScope("singleton");
    const p1 = root.resolve<Promise<Db>>("av:db");
    const p2 = root.resolve<Promise<Db>>("av:db");

    // Same Promise across resolves; factory ran exactly once.
    expect(p1).toBe(p2);
    expect(runs).toBe(1);

    const a = await p1;
    const b = await p2;
    expect(a).toBe(b); // awaiting twice yields the same instance
    expect(a).toBeInstanceOf(Db);
  });

  test("a consumer declaring the dep as Promise<T> receives the cached Promise (not awaited by the engine)", async () => {
    class Db {
      public readonly tag = "db";
    }
    class Consumer {
      public constructor(public readonly db: Promise<Db>) {}
    }
    // The consumer's ctor dep is the async db token — the engine passes the
    // Promise straight through as a value (never awaits it).
    defineDeps(Consumer, [["av:db2"]]);

    const services = new ServiceManifest<"singleton">();
    let runs = 0;
    services.addFactory("av:db2", () => {
      runs += 1;
      return Promise.resolve(new Db());
    }).as("singleton");
    services.add("av:consumer", Consumer).as("singleton");

    const root = services.build().createScope("singleton");
    const consumer = root.resolve<Consumer>("av:consumer");
    expect(consumer.db).toBeInstanceOf(Promise);
    // The same cached Promise the engine handed to the consumer.
    expect(consumer.db).toBe(root.resolve<Promise<Db>>("av:db2"));
    expect(runs).toBe(1);

    const db = await consumer.db;
    expect(db.tag).toBe("db");
  });
});
