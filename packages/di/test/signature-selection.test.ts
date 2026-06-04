import { test, expect, describe } from "bun:test";
import { ServiceManifest, NoSatisfiableSignatureError } from "@fnioc/di";
import { defineDeps } from "@fnioc/core";
import { T } from "./fixtures.js";

// Greedy signature selection over Token|FactoryRef|ScopeRef|Union signatures
// from getDeps. Scan longest → shortest; first SATISFIABLE wins. A FactoryRef
// and ScopeRef are always satisfiable (injected). A Union slot is satisfiable
// iff at least one member is resolvable. An unregistered string token is NOT
// satisfiable on a direct resolve. Equal-arity ties → registration order.
// None satisfiable → throw naming the unsatisfiable tokens.
// Optional/defaulted params are modeled as multiple overloads (longest first);
// when the longer one can't be satisfied, selection falls to the shorter one.

// A sentinel token that is never registered — used to model "caller-supplied"
// slots in the new design (replaces hole).
const UNREGISTERED = "test:unregistered" as const;

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

    const services = new ServiceManifest<"singleton">();
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

    const services = new ServiceManifest<"singleton">();
    services.add(T.Logger, LoggerImpl).as("singleton");
    // T.Db deliberately NOT registered.
    services.add(T.Service, Svc).as("singleton");

    const svc = services.build().resolve<Svc>(T.Service);
    expect(svc.args).toHaveLength(1);
    expect(svc.args[0]).toBeInstanceOf(LoggerImpl);
  });

  test("an unregistered slot blocks the signature; falls to the shorter overload", () => {
    // An unregistered token is an unresolvable slot — it blocks [Logger, UNREGISTERED]
    // so selection falls to the shorter [Logger] overload and constructs with one arg.
    // (This models an optional/defaulted param: the transformer emits both
    // overloads; the shorter one is chosen when the longer one can't be satisfied.)
    class Svc {
      public readonly args: unknown[];
      public constructor(...args: unknown[]) {
        this.args = args;
      }
    }
    defineDeps(Svc, [
      [T.Logger, UNREGISTERED],
      [T.Logger],
    ]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.Logger, LoggerImpl).as("singleton");
    // UNREGISTERED deliberately NOT registered.
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

    const services = new ServiceManifest<"singleton">();
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

    const services = new ServiceManifest<"singleton">();
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

  test("an all-unregistered signature is unsatisfiable on direct resolve; throws NoSatisfiableSignatureError", () => {
    // An unregistered token is not satisfiable on a direct resolve. A class with
    // only unregistered slots and no shorter fallback overload surfaces
    // NoSatisfiableSignatureError.
    // (To get the "optional" behavior, model as multiple overloads:
    //  defineDeps(Svc, [[UNREGISTERED], []]) — the zero-arg overload is the fallback.)
    class Svc {
      public readonly a: unknown;
      public constructor(a: unknown) {
        this.a = a;
      }
    }
    defineDeps(Svc, [[UNREGISTERED]]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.Service, Svc).as("singleton");
    // UNREGISTERED not registered.

    const root = services.build();
    expect(() => root.resolve<Svc>(T.Service)).toThrow(NoSatisfiableSignatureError);
  });

  test("throws naming only the unregistered token in a mixed signature", () => {
    // [Db, UNREGISTERED] — UNREGISTERED is fine as a caller-supplied slot would be,
    // but Db is also unregistered ⇒ both are unsatisfiable.
    class Svc {
      public constructor(..._args: unknown[]) {}
    }
    defineDeps(Svc, [[T.Db, UNREGISTERED]]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.Service, Svc).as("singleton"); // T.Db NOT registered

    const root = services.build();
    expect(() => root.resolve(T.Service)).toThrow(NoSatisfiableSignatureError);
    try {
      root.resolve(T.Service);
    } catch (err) {
      const e = err as NoSatisfiableSignatureError;
      // Both T.Db and UNREGISTERED are unregistered string tokens.
      expect(e.unsatisfiable).toContain(T.Db);
      expect(e.unsatisfiable).toContain(UNREGISTERED);
    }
  });
});
