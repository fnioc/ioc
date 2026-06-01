import { test, expect, describe } from "bun:test";
import { DiBuilder } from "@fnioc/di";
import { T } from "./fixtures.js";

// The override paths: useFactory / useValue (§"Override paths"). The recommended
// plugin-less mechanism. Plus async-as-values: a useFactory may be async; the
// container never awaits and a singleton-tagged async factory caches the
// Promise (factory runs once).

class Bar {
  public readonly kind = "bar";
}

describe("useValue", () => {
  test("returns the registered value verbatim, always the same reference", () => {
    const cached = { id: 42 };
    const services = new DiBuilder<"singleton">();
    services.add(T.Config, { useValue: cached });

    const root = services.build();
    expect(root.resolve<typeof cached>(T.Config)).toBe(cached);
    expect(root.resolve<typeof cached>(T.Config)).toBe(cached); // same every time
  });

  test("useValue resolves without any scope (no lifetime, no caching dance)", () => {
    const services = new DiBuilder<"singleton", "request">();
    services.add(T.Config, { useValue: "literal-value" });

    const req = services.build().createScope("request");
    expect(req.resolve<string>(T.Config)).toBe("literal-value");
  });
});

describe("useFactory", () => {
  test("runs the factory, resolving its own deps from the passed scope", () => {
    class Foo {
      public constructor(public readonly bar: Bar) {}
    }
    const services = new DiBuilder<"singleton">();
    services.add(T.B, Bar).as("singleton");
    services.add(T.A, {
      useFactory: (c) => new Foo(c.resolve<Bar>(T.B)),
    });

    const root = services.build();
    const foo = root.resolve<Foo>(T.A);
    expect(foo).toBeInstanceOf(Foo);
    expect(foo.bar).toBeInstanceOf(Bar);
  });

  test("an untagged factory runs on every resolve (transient)", () => {
    let calls = 0;
    const services = new DiBuilder<"singleton">();
    services.add(T.Service, {
      useFactory: () => {
        calls += 1;
        return { n: calls };
      },
    });

    const root = services.build();
    const a = root.resolve<{ n: number }>(T.Service);
    const b = root.resolve<{ n: number }>(T.Service);
    expect(calls).toBe(2);
    expect(a).not.toBe(b);
  });

  test("a singleton-scoped factory runs once and caches its result", () => {
    let calls = 0;
    const services = new DiBuilder<"singleton">();
    services.add(T.Service, {
      useFactory: () => {
        calls += 1;
        return { n: calls };
      },
      scope: "singleton",
    });

    const root = services.build();
    const a = root.resolve<{ n: number }>(T.Service);
    const b = root.resolve<{ n: number }>(T.Service);
    expect(calls).toBe(1);
    expect(a).toBe(b);
  });

  test("a request-scoped factory caches per request scope", () => {
    let calls = 0;
    const services = new DiBuilder<"singleton", "request">();
    services.add(T.Service, {
      useFactory: () => ({ n: ++calls }),
      scope: "request",
    });

    const root = services.build();
    const reqA = root.createScope("request");
    const reqB = root.createScope("request");

    const a1 = reqA.resolve(T.Service);
    const a2 = reqA.resolve(T.Service);
    const b1 = reqB.resolve(T.Service);

    expect(a1).toBe(a2); // cached within reqA
    expect(a1).not.toBe(b1); // distinct across request scopes
    expect(calls).toBe(2);
  });
});

describe("async as values", () => {
  test("resolve() returns the factory's Promise synchronously (no await)", () => {
    const services = new DiBuilder<"singleton">();
    services.add(T.Db, {
      useFactory: async () => ({ connected: true }),
      scope: "singleton",
    });

    const root = services.build();
    const result = root.resolve<Promise<{ connected: boolean }>>(T.Db);
    // The container did not await — resolve returned the Promise itself.
    expect(typeof (result as Promise<unknown>).then).toBe("function");
  });

  test("a singleton async factory runs once; both awaits see the same value", async () => {
    let calls = 0;
    const services = new DiBuilder<"singleton">();
    services.add(T.Db, {
      useFactory: async () => {
        calls += 1;
        return { id: calls };
      },
      scope: "singleton",
    });

    const root = services.build();
    const p1 = root.resolve<Promise<{ id: number }>>(T.Db);
    const p2 = root.resolve<Promise<{ id: number }>>(T.Db);

    // Same cached Promise — the factory ran exactly once.
    expect(p1).toBe(p2);
    const [a, b] = await Promise.all([p1, p2]);
    expect(calls).toBe(1);
    expect(a).toBe(b); // same resolved instance
    expect(a.id).toBe(1);
  });

  test("a consumer can await an injected Promise<T> dependency", async () => {
    const services = new DiBuilder<"singleton">();
    services.add(T.Db, {
      useFactory: async () => ({ query: () => "rows" }),
      scope: "singleton",
    });

    const root = services.build();
    const db = await root.resolve<Promise<{ query: () => string }>>(T.Db);
    expect(db.query()).toBe("rows");
  });
});
