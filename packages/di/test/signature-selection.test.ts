import { test, expect, describe } from "bun:test";
import { DiBuilder, NoSatisfiableSignatureError } from "@fnioc/di";
import { defineDeps, hole } from "@fnioc/core";
import { T } from "./fixtures.js";

// Greedy signature selection over Token|null|FactoryRef signatures from
// getDeps. Scan longest → shortest; first SATISFIABLE wins. A FactoryRef and
// ScopeRef are always satisfiable (injected). A null hole is NOT satisfiable
// on a direct resolve — it is an unresolvable slot that blocks the signature.
// An unregistered string token also blocks. Equal-arity ties → registration
// order. None satisfiable → throw naming the unsatisfiable tokens.
// Optional/defaulted params are modeled as multiple overloads (longest first);
// when the longer one can't be satisfied, selection falls to the shorter one.

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

  test("a hole in a required slot blocks the signature; falls to the shorter overload", () => {
    // Semantic change: hole is no longer "satisfiable" on a direct resolve.
    // A hole is an unresolvable slot — it blocks [Logger, hole] — so selection
    // falls to the shorter [Logger] overload and constructs with one arg.
    // (This models an optional/defaulted param: the transformer emits both
    // overloads; the shorter one is chosen when the longer one can't be satisfied.)
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
    // Selection falls to [T.Logger] — the shorter satisfiable overload.
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

  test("an all-hole signature is unsatisfiable on direct resolve; throws NoSatisfiableSignatureError", () => {
    // Semantic change: a hole is NOT satisfiable on a direct resolve. It is an
    // unresolvable slot that blocks the signature. A class with only holes and no
    // shorter fallback overload surfaces NoSatisfiableSignatureError.
    // (To get the "undefined/default" behavior, model as an optional overload:
    //  defineDeps(Svc, [[hole], []]) — the zero-arg overload is the fallback.)
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
    expect(() => root.resolve<Svc>(T.Service)).toThrow(NoSatisfiableSignatureError);
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
