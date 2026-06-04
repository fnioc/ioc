import { test, expect, describe } from "bun:test";
import {
  DiBuilder,
  CircularDependencyError,
  defineDeps,
  signature,
} from "@fnioc/di";

// Coverage 4 (uniform-tag transient fallback / §5.4 owning-scope rule), 5 (cycle
// detection), 9 (greedy overload selection). Each drives the engine through the
// ABI the transformer would emit, hand-fed so the rule under test is isolated
// from the compile step.

// ── Coverage 4: a singleton can't CACHE-CAPTURE a request-scoped service ──────

describe("uniform-tag fallback — a singleton holding a request-scoped dep gets a fresh transient", () => {
  test("the singleton caches in its open frame; its request-tagged dep (no enclosing request frame) is transient, never captured", () => {
    class RequestThing {
      public readonly id = Math.random();
    }
    class SingletonService {
      public constructor(public readonly thing: RequestThing) {}
    }
    defineDeps(RequestThing, [[]]);
    defineDeps(SingletonService, [["req:thing"]]);

    const services = new DiBuilder<"singleton" | "request">();
    services.add("req:thing", RequestThing).as("request");
    services.add("app:service", SingletonService).as("singleton");

    const app = services.build().createScope("singleton");
    // SingletonService is owned by the singleton frame; its "request"-tagged dep
    // has no ENCLOSING request frame there, so the dep resolves TRANSIENTLY — a
    // fresh instance, never a cached request instance. No throw: scopes are
    // uniform tags, and an absent frame is simply transient.
    const a = app.resolve<SingletonService>("app:service");
    const b = app.resolve<SingletonService>("app:service");
    expect(a).toBe(b); // the singleton itself caches in the open singleton frame
    expect(a.thing).toBeInstanceOf(RequestThing);
  });

  test("the SAME service resolves cleanly when its dependency shares the singleton lifetime", () => {
    class Dep {}
    class Service {
      public constructor(public readonly dep: Dep) {}
    }
    defineDeps(Dep, [[]]);
    defineDeps(Service, [["app:dep"]]);

    const services = new DiBuilder<"singleton">();
    services.add("app:dep", Dep).as("singleton");
    services.add("app:service", Service).as("singleton");

    const svc = services.build().createScope("singleton").resolve<Service>("app:service");
    expect(svc.dep).toBeInstanceOf(Dep);
  });
});

// ── Coverage 5: cycle detection (full path in the message) ────────────────────

describe("cycle detection — A → B → A throws with the full resolution path", () => {
  test("a 2-cycle reports the path that closed the loop", () => {
    class A {
      public constructor(public readonly b: unknown) {}
    }
    class B {
      public constructor(public readonly a: unknown) {}
    }
    defineDeps(A, [["cy:B"]]);
    defineDeps(B, [["cy:A"]]);

    const services = new DiBuilder<"singleton">();
    services.add("cy:A", A).as("singleton");
    services.add("cy:B", B).as("singleton");

    let caught: unknown;
    try {
      services.build().resolve("cy:A");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CircularDependencyError);
    const message = (caught as Error).message;
    expect(message).toContain("Circular dependency");
    // Full path including the token that re-closed the cycle.
    expect(message).toContain("cy:A → cy:B → cy:A");
    expect((caught as CircularDependencyError).path).toEqual([
      "cy:A",
      "cy:B",
      "cy:A",
    ]);
  });

  test("a 3-cycle A → B → C → A reports all three hops", () => {
    class A {
      public constructor(public readonly b: unknown) {}
    }
    class B {
      public constructor(public readonly c: unknown) {}
    }
    class C {
      public constructor(public readonly a: unknown) {}
    }
    defineDeps(A, [["cy3:B"]]);
    defineDeps(B, [["cy3:C"]]);
    defineDeps(C, [["cy3:A"]]);

    const services = new DiBuilder<"singleton">();
    services.add("cy3:A", A).as("singleton");
    services.add("cy3:B", B).as("singleton");
    services.add("cy3:C", C).as("singleton");

    expect(() => services.build().resolve("cy3:A")).toThrow(
      /cy3:A → cy3:B → cy3:C → cy3:A/,
    );
  });
});

// ── Coverage 9: greedy overload selection ─────────────────────────────────────

describe("greedy overload selection — longest satisfiable signature wins", () => {
  test("di selects the LONGEST signature when every token is registered", () => {
    class Multi {
      public readonly via: string;
      public constructor(...args: unknown[]) {
        // Identify which overload was chosen by arity.
        this.via = args.length === 2 ? "long" : "short";
      }
    }
    // Two overloads (stacked @signature equivalent): a 1-arg and a 2-arg form.
    defineDeps(Multi, [["ov:logger"], ["ov:logger", "ov:db"]]);

    class Logger {}
    class Db {}
    defineDeps(Logger, [[]]);
    defineDeps(Db, [[]]);

    const services = new DiBuilder<"singleton">();
    services.add("ov:logger", Logger).as("singleton");
    services.add("ov:db", Db).as("singleton");
    services.add("ov:multi", Multi).as("singleton");

    const m = services.build().resolve<Multi>("ov:multi");
    expect(m.via).toBe("long"); // 2-arg form chosen — both deps registered
  });

  test("di FALLS BACK to a shorter signature when the longest is unsatisfiable", () => {
    class Multi {
      public readonly arity: number;
      public constructor(...args: unknown[]) {
        this.arity = args.length;
      }
    }
    defineDeps(Multi, [["fb:logger"], ["fb:logger", "fb:db"]]);

    class Logger {}
    defineDeps(Logger, [[]]);

    const services = new DiBuilder<"singleton">();
    services.add("fb:logger", Logger).as("singleton");
    // fb:db is NOT registered → the 2-arg form is unsatisfiable.
    services.add("fb:multi", Multi).as("singleton");

    const m = services.build().resolve<Multi>("fb:multi");
    expect(m.arity).toBe(1); // longest satisfiable is the 1-arg form
  });

  test("equal-arity ties break by REGISTRATION ORDER (first declared wins)", () => {
    class Pick {
      public readonly token: unknown;
      public constructor(dep: { tag: string }) {
        this.token = dep.tag;
      }
    }
    // Two equal-arity signatures; the FIRST should win when both are satisfiable.
    defineDeps(Pick, [["tie:first"], ["tie:second"]]);

    class First {
      public readonly tag = "first";
    }
    class Second {
      public readonly tag = "second";
    }
    defineDeps(First, [[]]);
    defineDeps(Second, [[]]);

    const services = new DiBuilder<"singleton">();
    services.add("tie:first", First).as("singleton");
    services.add("tie:second", Second).as("singleton");
    services.add("tie:pick", Pick).as("singleton");

    const p = services.build().resolve<Pick>("tie:pick");
    expect(p.token).toBe("first"); // registration-order tie-break
  });

  test("a @signature-decorated multi-overload class selects greedily (decorator path)", () => {
    @signature("dec:logger", "dec:db")
    @signature("dec:logger")
    class Decorated {
      public readonly arity: number;
      public constructor(...args: unknown[]) {
        this.arity = args.length;
      }
    }
    class Logger {}
    defineDeps(Logger, [[]]);

    const services = new DiBuilder<"singleton">();
    services.add("dec:logger", Logger).as("singleton");
    // dec:db unregistered → falls back to the 1-arg overload.
    services.add("dec:decorated", Decorated).as("singleton");

    const d = services.build().resolve<Decorated>("dec:decorated");
    expect(d.arity).toBe(1);
  });
});
