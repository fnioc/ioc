import { test, expect, describe } from "bun:test";
import { DiBuilder } from "@fnioc/di";
import { defineDeps } from "@fnioc/core";
import { T } from "./fixtures.js";

// Registration + basic resolution, transient vs singleton caching, `.as`
// tagging — all hand-fed (no transformer).

class ConsoleLogger {
  public readonly kind = "console";
}

class SqlDb {
  public readonly kind = "sql";
}

class Repo {
  public constructor(
    public readonly logger: ConsoleLogger,
    public readonly db: SqlDb,
  ) {}
}

describe("registration + basic resolution", () => {
  test("resolves a zero-arg class via its token", () => {
    const services = new DiBuilder<"singleton">();
    services.add(T.Logger, ConsoleLogger).as("singleton");

    const root = services.build();
    const logger = root.resolve<ConsoleLogger>(T.Logger);

    expect(logger).toBeInstanceOf(ConsoleLogger);
    expect(logger.kind).toBe("console");
  });

  test("resolves a class with dependencies (greedy single signature)", () => {
    const services = new DiBuilder<"singleton">();
    defineDeps(Repo, [[T.Logger, T.Db]]);
    services.add(T.Logger, ConsoleLogger).as("singleton");
    services.add(T.Db, SqlDb).as("singleton");
    services.add(T.Repo, Repo).as("singleton");

    const root = services.build();
    const repo = root.resolve<Repo>(T.Repo);

    expect(repo).toBeInstanceOf(Repo);
    expect(repo.logger).toBeInstanceOf(ConsoleLogger);
    expect(repo.db).toBeInstanceOf(SqlDb);
  });

  test("addValue registers a value that resolves verbatim; class add returns AddBuilder", () => {
    // Semantic change: the old add(token, { useValue }) object shape is removed.
    // addValue(token, value) is the new surface; it returns void (no chaining).
    // Class add still returns an AddBuilder for .as() tagging.
    const services = new DiBuilder<"singleton">();
    services.addValue(T.Config, { v: 1 });
    const addBuilder = services.add(T.Logger, class L {});
    expect(typeof addBuilder.as).toBe("function");
    // The value registered above resolves correctly.
    expect(services.build().resolve<{ v: number }>(T.Config)).toEqual({ v: 1 });
  });
});

describe("transient vs singleton caching", () => {
  test("singleton: same instance on repeated resolve in the owning scope", () => {
    const services = new DiBuilder<"singleton">();
    services.add(T.Logger, ConsoleLogger).as("singleton");

    const root = services.build();
    const a = root.resolve<ConsoleLogger>(T.Logger);
    const b = root.resolve<ConsoleLogger>(T.Logger);

    expect(a).toBe(b);
  });

  test("transient (untagged): fresh instance every resolve, never cached", () => {
    const services = new DiBuilder<"singleton">();
    services.add(T.Logger, ConsoleLogger); // no .as() ⇒ transient

    const root = services.build();
    const a = root.resolve<ConsoleLogger>(T.Logger);
    const b = root.resolve<ConsoleLogger>(T.Logger);

    expect(a).not.toBe(b);
    expect(a).toBeInstanceOf(ConsoleLogger);
    expect(b).toBeInstanceOf(ConsoleLogger);
  });

  test("singleton is shared across child scopes (owned by the ancestor)", () => {
    const services = new DiBuilder<"singleton", "request">();
    services.add(T.Logger, ConsoleLogger).as("singleton");

    const root = services.build();
    const reqA = root.createScope("request");
    const reqB = root.createScope("request");

    const fromA = reqA.resolve<ConsoleLogger>(T.Logger);
    const fromB = reqB.resolve<ConsoleLogger>(T.Logger);
    const fromRoot = root.resolve<ConsoleLogger>(T.Logger);

    expect(fromA).toBe(fromB);
    expect(fromA).toBe(fromRoot);
  });
});

describe(".as tagging", () => {
  test("request-tagged: one instance per request scope, distinct across them", () => {
    const services = new DiBuilder<"singleton", "request">();
    services.add(T.Db, SqlDb).as("request");

    const root = services.build();
    const reqA = root.createScope("request");
    const reqB = root.createScope("request");

    const a1 = reqA.resolve<SqlDb>(T.Db);
    const a2 = reqA.resolve<SqlDb>(T.Db);
    const b1 = reqB.resolve<SqlDb>(T.Db);

    expect(a1).toBe(a2); // cached within reqA
    expect(a1).not.toBe(b1); // distinct across request scopes
  });

  test("untagged add is transient — no .as() call needed to opt out", () => {
    const services = new DiBuilder<"request">();
    services.add(T.Service, ConsoleLogger);

    const root = services.build();
    expect(root.resolve(T.Service)).not.toBe(root.resolve(T.Service));
  });
});
