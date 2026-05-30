import { test, expect, describe } from "bun:test";
import { DiBuilder, NoSatisfiableSignatureError } from "@fnioc/di";
import { defineDeps, hole } from "@fnioc/core";
import { T } from "./fixtures.js";

// Greedy signature selection over plain Token|null signatures from getDeps.
// Scan longest → shortest; first DIRECTLY satisfiable wins. A null hole is NOT
// directly satisfiable this phase (holes are Phase 2D) — hole-containing
// signatures are skipped. Equal-arity ties → registration order. None
// satisfiable → throw naming the unsatisfiable tokens.

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

    const svc = services.createScope("singleton").resolve<Svc>(T.Service);
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

    const svc = services.createScope("singleton").resolve<Svc>(T.Service);
    expect(svc.args).toHaveLength(1);
    expect(svc.args[0]).toBeInstanceOf(LoggerImpl);
  });

  test("skips a hole-containing signature even if longer (holes are Phase 2D)", () => {
    // Longest is [Logger, hole] — contains a hole ⇒ skipped this phase. The
    // shorter all-token [Logger] is selected instead.
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

    const svc = services.createScope("singleton").resolve<Svc>(T.Service);
    expect(svc.args).toHaveLength(1);
    expect(svc.args[0]).toBeInstanceOf(LoggerImpl);
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

    const svc = services.createScope("singleton").resolve<Svc>(T.Service);
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

    const root = services.createScope("singleton");
    expect(() => root.resolve(T.Service)).toThrow(NoSatisfiableSignatureError);

    try {
      root.resolve(T.Service);
    } catch (err) {
      const e = err as NoSatisfiableSignatureError;
      expect(e.unsatisfiable).toContain(T.Logger);
      expect(e.unsatisfiable).toContain(T.Db);
    }
  });

  test("an all-hole signature with no alternative throws (no fillable sig)", () => {
    class Svc {
      public constructor(public readonly a: unknown) {}
    }
    defineDeps(Svc, [[hole]]);

    const services = new DiBuilder<"singleton">();
    services.add(T.Service, Svc).as("singleton");

    const root = services.createScope("singleton");
    // The only signature contains a hole ⇒ not directly satisfiable ⇒ throw.
    expect(() => root.resolve(T.Service)).toThrow(NoSatisfiableSignatureError);
  });
});
