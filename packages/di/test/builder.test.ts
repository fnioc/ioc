import { test, expect, describe } from "bun:test";
import { DiBuilder, signature, forCtor, hole } from "@fnioc/di";
import { getDeps } from "@fnioc/core";
import { T } from "./fixtures.js";

// Builder edge cases + the one-import re-export ergonomics.

describe("DiBuilder.add runtime guard", () => {
  test("the type-only add<I>(ctor) form throws if invoked directly at runtime", () => {
    class Foo {}
    const services = new DiBuilder<"singleton">();
    // The transformer lowers add<I>(ctor) → add(token, ctor). Calling the
    // single-arg form at runtime (no transform) is a misuse — fail loud.
    expect(() =>
      (services.add as (c: unknown) => unknown)(Foo),
    ).toThrow(TypeError);
  });

  test("a later .add() for the same token overrides the earlier registration", () => {
    class First {
      public readonly which = "first";
    }
    class Second {
      public readonly which = "second";
    }
    const services = new DiBuilder<"singleton">();
    services.add(T.Service, First).as("singleton");
    services.add(T.Service, Second).as("singleton");

    const resolved = services.build().resolve<First | Second>(T.Service);
    expect(resolved.which).toBe("second");
  });
});

describe("re-exports from @fnioc/core", () => {
  test("hole compares to itself by identity (sentinel, not a literal value)", () => {
    expect(hole).toBe(hole);
  });

  test("signature writes a DepRecord readable via core's getDeps", () => {
    @signature(T.Logger, T.Db)
    class Decorated {
      public constructor(
        public readonly log: unknown,
        public readonly db: unknown,
      ) {}
    }
    const rec = getDeps(Decorated);
    expect(rec?.signatures).toContainEqual([T.Logger, T.Db]);
  });

  test("forCtor writes a DepRecord for a class you don't own", () => {
    class ThirdParty {
      public constructor(public readonly db: unknown) {}
    }
    forCtor(ThirdParty).signature(T.Db);
    const rec = getDeps(ThirdParty);
    expect(rec?.signatures).toContainEqual([T.Db]);
  });

  test("a forCtor-annotated class resolves through the engine end to end", () => {
    class DbImpl {
      public readonly kind = "db";
    }
    class Consumer {
      public constructor(public readonly db: DbImpl) {}
    }
    forCtor(Consumer).signature(T.Db);

    const services = new DiBuilder<"singleton">();
    services.add(T.Db, DbImpl).as("singleton");
    services.add(T.Service, Consumer).as("singleton");

    const c = services.build().resolve<Consumer>(T.Service);
    expect(c.db).toBeInstanceOf(DbImpl);
  });
});
