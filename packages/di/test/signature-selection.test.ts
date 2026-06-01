import { test, expect, describe } from "bun:test";
import { DiBuilder, NoSatisfiableSignatureError } from "@fnioc/di";
import { defineDeps, hole } from "@fnioc/core";
import { T } from "./fixtures.js";

// Greedy signature selection over Token|null|FactoryRef signatures from
// getDeps. Scan longest → shortest; first SATISFIABLE wins. A null hole and a
// FactoryRef are always satisfiable (Phase 2D.2: a hole is caller-supplied, a
// FactoryRef is injected) — only an unregistered string token blocks a
// signature. Equal-arity ties → registration order. None satisfiable → throw
// naming the unsatisfiable tokens.

class LoggerImpl {
  public readonly kind = "logger";
}
class DbImpl {
  public readonly kind = "db";
}

describe("greedy signature selection", () => {
  test("longest satisfiable signature wins when both are satisfiable", () => {
    // Two overloads: [Logger, Db] and [Db]. Both satisfiable; the longer wins.
    class Svc {
      public readonly args: unknown[];
      public constructor(...args: unknown[]) {
        this.args = args;
      }
    }
    defineDeps(Svc, [
      [T.Logger, T.Db],
      [T.Db],
    ]);

    const services = new DiBuilder<"singleton">();
    services.add(T.Logger, LoggerImpl).as("singleton");
    services.add(T.Db, DbImpl).as("singleton");
    services.add(T.Service, Svc).as("singleton");

    const svc = services.build().resolve<Svc>(T.Service);
    expect(svc.args).toHaveLength(2);
    expect(svc.args[0]).toBeInstanceOf(LoggerImpl);
    expect(svc.args[1]).toBeInstanceOf(DbImpl);
  });

  test("falls back to a shorter signature when the longest is unsatisfiable", () => {
    // [Logger, Db] needs Db (unregistered) ⇒ skip. [Logger] is satisfiable.
    class Svc {
      public readonly args: unknown[];
      public constructor(...args: unknown[]) {
        this.args = args;
      }
    }
    defineDeps(Svc, [
      [T.Logger, T.Db],
      [T.Logger],
    ]);

    const services = new DiBuilder<"singleton">();
    services.add(T.Logger, LoggerImpl).as("singleton");
    // T.Db deliberately NOT registered.
    services.add(T.Service, Svc).as("singleton");

    const svc = services.build().resolve<Svc>(T.Service);
    expect(svc.args).toHaveLength(1);
    expect(svc.args[0]).toBeInstanceOf(LoggerImpl);
  });

  test("a hole-containing signature is satisfiable and the longest wins", () => {
    // Longest is [Logger, hole] — a hole is satisfiable (caller-supplied), so
    // this longer signature now wins over the shorter [Logger]. On a DIRECT
    // resolve there is no caller, so the hole lands as `undefined`.
    class Svc {
      public readonly args: unknown[];
      public constructor(...args: unknown[]) {
        this.args = args;
      }
    }
    defineDeps(Svc, [
      [T.Logger, hole],
      [T.Logger],
    ]);

    const services = new DiBuilder<"singleton">();
    services.add(T.Logger, LoggerImpl).as("singleton");
    services.add(T.Service, Svc).as("singleton");

    const svc = services.build().resolve<Svc>(T.Service);
    expect(svc.args).toHaveLength(2);
    expect(svc.args[0]).toBeInstanceOf(LoggerImpl);
    expect(svc.args[1]).toBeUndefined(); // hole, unfilled on a direct resolve
  });

  test("equal-arity tie breaks by registration order (first declared wins)", () => {
    // Two same-length signatures, both satisfiable. The first in the DepRecord
    // (registration order) is chosen. Distinct tokens so we can tell which ran.
    class Svc {
      public readonly args: unknown[];
      public constructor(...args: unknown[]) {
        this.args = args;
      }
    }
    // [Logger] declared first, [Db] second — both arity 1, both registered.
    defineDeps(Svc, [[T.Logger], [T.Db]]);

    const services = new DiBuilder<"singleton">();
    services.add(T.Logger, LoggerImpl).as("singleton");
    services.add(T.Db, DbImpl).as("singleton");
    services.add(T.Service, Svc).as("singleton");

    const svc = services.build().resolve<Svc>(T.Service);
    expect(svc.args).toHaveLength(1);
    // First-declared signature ([Logger]) wins the equal-arity tie.
    expect(svc.args[0]).toBeInstanceOf(LoggerImpl);
  });

  test("throws NoSatisfiableSignatureError naming the unsatisfiable tokens", () => {
    class Svc {
      public constructor(..._args: unknown[]) {}
    }
    defineDeps(Svc, [[T.Logger, T.Db]]);

    const services = new DiBuilder<"singleton">();
    // Neither Logger nor Db registered.
    services.add(T.Service, Svc).as("singleton");

    const root = services.build();
    expect(() => root.resolve(T.Service)).toThrow(NoSatisfiableSignatureError);

    try {
      root.resolve(T.Service);
    } catch (err) {
      const e = err as NoSatisfiableSignatureError;
      expect(e.unsatisfiable).toContain(T.Logger);
      expect(e.unsatisfiable).toContain(T.Db);
    }
  });

  test("an all-hole signature is satisfiable; a direct resolve fills it undefined", () => {
    // A hole is satisfiable on its own. On a direct resolve there is no caller,
    // so the single hole lands as `undefined` — the class is still built.
    class Svc {
      public readonly a: unknown;
      public constructor(a: unknown) {
        this.a = a;
      }
    }
    defineDeps(Svc, [[hole]]);

    const services = new DiBuilder<"singleton">();
    services.add(T.Service, Svc).as("singleton");

    const root = services.build();
    const svc = root.resolve<Svc>(T.Service);
    expect(svc).toBeInstanceOf(Svc);
    expect(svc.a).toBeUndefined();
  });

  test("throws naming only the unsatisfiable token, ignoring holes", () => {
    // [Db, hole] — the hole is fine, but Db is unregistered ⇒ unsatisfiable.
    class Svc {
      public constructor(..._args: unknown[]) {}
    }
    defineDeps(Svc, [[T.Db, hole]]);

    const services = new DiBuilder<"singleton">();
    services.add(T.Service, Svc).as("singleton"); // Db NOT registered

    const root = services.build();
    expect(() => root.resolve(T.Service)).toThrow(NoSatisfiableSignatureError);
    try {
      root.resolve(T.Service);
    } catch (err) {
      const e = err as NoSatisfiableSignatureError;
      expect(e.unsatisfiable).toEqual([T.Db]); // only the token, never the hole
    }
  });
});
