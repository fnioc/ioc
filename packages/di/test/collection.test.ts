import { test, expect, describe } from "bun:test";
import { DiBuilder } from "@fnioc/di";
import { T } from "./fixtures.js";

// The redesigned registration surface: the service collection
// (Map<Token, Registration[]>) with last-wins resolution, the three `add`
// shapes (class / useFactory / useValue), and `build()` minting the root with
// nested `createScope` children.

describe("service collection — last-wins over a retained list", () => {
  test("the most-recent class registration wins", () => {
    class First {
      public readonly which = "first";
    }
    class Second {
      public readonly which = "second";
    }
    class Third {
      public readonly which = "third";
    }
    const services = new DiBuilder<"singleton">();
    services.add(T.Service, First).as("singleton");
    services.add(T.Service, Second).as("singleton");
    services.add(T.Service, Third).as("singleton");

    const resolved = services.build().resolve<Third>(T.Service);
    expect(resolved.which).toBe("third");
  });

  test("a later useValue overrides an earlier class registration", () => {
    class Real {
      public readonly which = "real";
    }
    const fake = { which: "fake" };
    const services = new DiBuilder<"singleton">();
    services.add(T.Service, Real).as("singleton");
    services.addValue(T.Service, fake);

    expect(services.build().resolve<typeof fake>(T.Service)).toBe(fake);
  });

  test("a later class registration overrides an earlier addFactory", () => {
    class Winner {
      public readonly which = "winner";
    }
    const services = new DiBuilder<"singleton">();
    services.addFactory(T.Service, () => ({ which: "factory" })).as("singleton");
    services.add(T.Service, Winner).as("singleton");

    const resolved = services.build().resolve<Winner>(T.Service);
    expect(resolved).toBeInstanceOf(Winner);
    expect(resolved.which).toBe("winner");
  });

  test("multiple builder registrations for the same token — last-wins", () => {
    const services = new DiBuilder<"singleton", "request">();
    services.addValue(T.Config, "v1");
    services.addValue(T.Config, "v2");
    services.addValue(T.Config, "v3");

    const root = services.build();
    // Most-recent (last appended) registration wins.
    expect(root.resolve<string>(T.Config)).toBe("v3");
    // Child scope sees the same sealed map — no local overrides exist.
    const req = root.createScope("request");
    expect(req.resolve<string>(T.Config)).toBe("v3");
  });
});

describe("the three add shapes", () => {
  test("class — add(token, Ctor).as(scope) caches at the owning scope", () => {
    class Svc {
      public readonly id = Math.random();
    }
    const services = new DiBuilder<"singleton">();
    services.add(T.Service, Svc).as("singleton");

    const root = services.build();
    expect(root.resolve<Svc>(T.Service)).toBe(root.resolve<Svc>(T.Service));
  });

  test("factory — addFactory(token, fn).as(scope) resolves its own deps", () => {
    class Dep {
      public readonly kind = "dep";
    }
    const services = new DiBuilder<"singleton">();
    services.add(T.Db, Dep).as("singleton");
    services.addFactory(T.Service, (s) => ({ dep: s.resolve<Dep>(T.Db) })).as("singleton");

    const root = services.build();
    const a = root.resolve<{ dep: Dep }>(T.Service);
    const b = root.resolve<{ dep: Dep }>(T.Service);
    expect(a).toBe(b); // .as("singleton") caches the result
    expect(a.dep).toBeInstanceOf(Dep);
  });

  test("value — addValue(token, value) returns the instance verbatim", () => {
    const value = { v: 1 };
    const services = new DiBuilder<"singleton">();
    services.addValue(T.Config, value);

    expect(services.build().resolve<typeof value>(T.Config)).toBe(value);
  });

  test("addFactory returns AddBuilder for .as() chaining; addValue returns void", () => {
    // addValue returns void (no chaining); addFactory returns an AddBuilder.
    // Semantic change: old add(token, { useValue }) returned the builder;
    // addValue(token, value) is void by design — values have no lifetime to tag.
    const services = new DiBuilder<"singleton">();
    const factoryBuilder = services.addFactory(T.B, () => 2);
    expect(typeof factoryBuilder.as).toBe("function");
    // addValue is fire-and-forget: just assert it does not throw.
    expect(() => services.addValue(T.A, 1)).not.toThrow();
  });
});

describe("build() root + nested createScope", () => {
  test("build() mints the root named by Root (default 'singleton')", () => {
    const services = new DiBuilder<"singleton">();
    services.add(T.Logger, class L {}).as("singleton");
    const root = services.build();
    expect(root.name).toBe("singleton");
  });

  test("build() honours an explicit non-default Root name at runtime", () => {
    class App {
      public readonly kind = "app";
    }
    const services = new DiBuilder<"app", "request">("app");
    services.add(T.Service, App).as("app");

    const root = services.build();
    expect(root.name).toBe("app");
    expect(root.resolve<App>(T.Service)).toBeInstanceOf(App);
  });

  test("child scopes nest from the root via createScope", () => {
    class Req {
      public readonly id = Math.random();
    }
    const services = new DiBuilder<"singleton", "request">();
    services.add(T.Service, Req).as("request");

    const root = services.build();
    const reqA = root.createScope("request");
    const reqB = root.createScope("request");

    expect(reqA.name).toBe("request");
    expect(reqA.resolve<Req>(T.Service)).not.toBe(
      reqB.resolve<Req>(T.Service),
    );
  });

  test("the root name is a usable .as() target (singletons bind to it)", () => {
    class Shared {
      public readonly id = Math.random();
    }
    const services = new DiBuilder<"singleton", "request">();
    services.add(T.Service, Shared).as("singleton");

    const root = services.build();
    const deep = root.createScope("request").createScope("request");
    // Owned by the root "singleton" scope, shared across the whole subtree.
    expect(deep.resolve<Shared>(T.Service)).toBe(
      root.resolve<Shared>(T.Service),
    );
  });
});
