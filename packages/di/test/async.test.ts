import { test, expect, describe } from "bun:test";
import {
  ServiceManifest,
  AsyncResolutionRequiredError,
  AsyncDisposalRequiredError,
  UnregisteredTokenError,
  NoSatisfiableSignatureError,
} from "@fnioc/di";
import { closeToken, union } from "@fnioc/core";
import type { Token } from "@fnioc/core";
import { defineDeps } from "./fixtures.js";

// The trampoline resolver spine: resolve() is deterministic-sync, resolveAsync()
// is the ONLY path that may satisfy T via an honest `Promise<T>` registration.
// Async never leaks a Pending carrier through the public surface.

const T = {
  Config: "pkg:IConfig" as Token,
  Widget: "pkg:IWidget" as Token,
  Scoped: "pkg:IScoped" as Token,
  A: "pkg:IA" as Token,
  B: "pkg:IB" as Token,
  UnionHolder: "pkg:IUnionHolder" as Token,
  Raw: "pkg:IRaw" as Token,
} as const;

/** The honest `Promise<T>` token — where an async-only registration truly lives. */
function promiseOf(token: Token): Token {
  return closeToken("Promise", token);
}

describe("resolveAsync — honest Promise<T> fallback", () => {
  test("a manual Promise<T> registration resolves via resolveAsync to the awaited T", async () => {
    const services = new ServiceManifest();
    services.addValue(promiseOf(T.Config), Promise.resolve({ url: "db://x" }));

    const provider = services.build();
    const config = await provider.resolveAsync<{ url: string }>(T.Config);

    expect(config).toEqual({ url: "db://x" });
  });

  test("a sync resolve of an async-only token is an honest UnregisteredTokenError", () => {
    const services = new ServiceManifest();
    services.addValue(promiseOf(T.Config), Promise.resolve({ url: "db://x" }));

    const provider = services.build();

    // Sync mode gates the Promise<T> fallback OFF — the miss is honest.
    expect(() => provider.resolve(T.Config)).toThrow(UnregisteredTokenError);
  });

  test("resolve(Promise<X>) returns the RAW promise as a value, synchronously", async () => {
    const promise = Promise.resolve(42);
    const services = new ServiceManifest();
    // Registered at its TRUE Promise<X> type — a raw promise IS the instance.
    services.addValue(T.Raw, promise);

    const value = services.build().resolve(T.Raw);

    expect(value).toBeInstanceOf(Promise);
    expect(value).toBe(promise);
    expect(await (value as Promise<number>)).toBe(42);
  });

  test("transitive async: a sync class whose dep only resolves via the fallback builds under resolveAsync", async () => {
    class Widget {
      public constructor(public readonly config: { url: string }) {}
    }
    defineDeps(Widget, [[T.Config]]);

    const services = new ServiceManifest();
    services.add(T.Widget, Widget);
    services.addFactory(promiseOf(T.Config), () =>
      Promise.resolve({ url: "db://transitive" }),
    );

    const provider = services.build();

    // Sync cannot: the dep is not resolvable without the async fallback.
    expect(() => provider.resolve(T.Widget)).toThrow(
      NoSatisfiableSignatureError,
    );

    const widget = await provider.resolveAsync<Widget>(T.Widget);
    expect(widget).toBeInstanceOf(Widget);
    expect(widget.config).toEqual({ url: "db://transitive" });
  });
});

describe("resolveAsync — single-flight + cached-Pending semantics", () => {
  test("two overlapping resolveAsync for one scoped async token share ONE construction", async () => {
    let ctorRuns = 0;
    let factoryRuns = 0;

    class AsyncScoped {
      public constructor(public readonly config: { n: number }) {
        ctorRuns += 1;
      }
    }
    defineDeps(AsyncScoped, [[T.Config]]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.Scoped, AsyncScoped).as("singleton");
    services.addFactory(promiseOf(T.Config), () => {
      factoryRuns += 1;
      return Promise.resolve({ n: 7 });
    });

    const scope = services.build().createScope("singleton");

    // Fire both BEFORE awaiting — the second must hit the cached in-flight
    // Pending, not start a second construction.
    const [a, b] = await Promise.all([
      scope.resolveAsync<AsyncScoped>(T.Scoped),
      scope.resolveAsync<AsyncScoped>(T.Scoped),
    ]);

    expect(a).toBe(b);
    expect(ctorRuns).toBe(1);
    expect(factoryRuns).toBe(1);
    expect(a.config).toEqual({ n: 7 });
  });

  test("a concurrent SYNC resolve hitting a cached in-flight Pending throws AsyncResolutionRequiredError", async () => {
    class AsyncScoped {
      public constructor(public readonly config: { n: number }) {}
    }
    defineDeps(AsyncScoped, [[T.Config]]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.Scoped, AsyncScoped).as("singleton");
    services.addFactory(promiseOf(T.Config), () => Promise.resolve({ n: 1 }));

    const scope = services.build().createScope("singleton");

    // Kick off the async build; its Pending is cached synchronously.
    const inFlight = scope.resolveAsync<AsyncScoped>(T.Scoped);

    // A sync resolve now hits the cached Pending — it cannot wait.
    expect(() => scope.resolve(T.Scoped)).toThrow(AsyncResolutionRequiredError);

    await inFlight; // let it settle so nothing dangles
  });
});

describe("resolveAsync — union async-reject fall-through", () => {
  test("first member's Promise rejects → the second member satisfies", async () => {
    class UnionHolder {
      public constructor(public readonly dep: unknown) {}
    }
    defineDeps(UnionHolder, [[union(T.A, T.B)]]);

    const services = new ServiceManifest();
    services.add(T.UnionHolder, UnionHolder);
    // Member A resolves only via the async fallback — and rejects.
    services.addFactory(promiseOf(T.A), () =>
      Promise.reject(new Error("A is down")),
    );
    // Member B is a plain value — the fall-through winner.
    services.addValue(T.B, { source: "B" });

    const holder = await services
      .build()
      .resolveAsync<UnionHolder>(T.UnionHolder);

    expect(holder.dep).toEqual({ source: "B" });
  });
});

describe("disposal of async-owned instances", () => {
  test("sync dispose on an owned Pending throws AsyncDisposalRequiredError", async () => {
    class AsyncScoped {
      public constructor(public readonly config: { n: number }) {}
    }
    defineDeps(AsyncScoped, [[T.Config]]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.Scoped, AsyncScoped).as("singleton");
    services.addFactory(promiseOf(T.Config), () => Promise.resolve({ n: 1 }));

    const scope = services.build().createScope("singleton");
    await scope.resolveAsync<AsyncScoped>(T.Scoped); // owns a Pending

    // `owned` is never upgraded — the Pending is still there after settling.
    expect(() => scope.dispose()).toThrow(AsyncDisposalRequiredError);
  });

  test("disposeAsync awaits the owned Pending, then disposes the settled instance", async () => {
    const disposed: string[] = [];

    class AsyncScoped implements Disposable {
      public constructor(public readonly config: { n: number }) {}
      public [Symbol.dispose](): void {
        disposed.push("scoped");
      }
    }
    defineDeps(AsyncScoped, [[T.Config]]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.Scoped, AsyncScoped).as("singleton");
    services.addFactory(promiseOf(T.Config), () => Promise.resolve({ n: 1 }));

    const scope = services.build().createScope("singleton");
    const instance = await scope.resolveAsync<AsyncScoped>(T.Scoped);

    await scope.disposeAsync();

    expect(disposed).toEqual(["scoped"]);
    expect(instance.config).toEqual({ n: 1 });
  });
});
