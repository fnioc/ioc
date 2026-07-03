import { test, expect, describe } from "bun:test";
import { ServiceManifest, NoSatisfiableUnionError, NoSatisfiableSignatureError } from "@fnioc/di";
import { union } from "@fnioc/core";
import { defineDeps } from "./fixtures.js";
import type { FactoryRef } from "@fnioc/core";
import { T } from "./fixtures.js";

// Union slot resolution: first resolvable member wins; fallthrough when first
// is unregistered; exhaustion throws NoSatisfiableUnionError.
//
// Union satisfiability in selectSignature: a Union slot counts as satisfiable
// iff at least one member is resolvable; if none is resolvable, the signature
// containing it is unsatisfiable.

class RedisImpl {
  public readonly kind = "redis";
}
class MemoryCacheImpl {
  public readonly kind = "memory";
}
class LoggerImpl {
  public readonly kind = "logger";
}

// ── FactoryRef field — the T0 rename ────────────────────────────────────────

describe("FactoryRef.type field (T0 rename)", () => {
  test("a FactoryRef with .type field injects a callable", () => {
    class Target {
      public readonly built = true;
    }
    class Holder {
      public constructor(public readonly make: () => Target) {}
    }
    const ref: FactoryRef = { type: T.Service };
    defineDeps(Holder, [[ref]]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.Service, Target).as("singleton");
    services.add(T.Repo, Holder).as("singleton");

    const holder = services.build().resolve<Holder>(T.Repo);
    expect(holder.make()).toBeInstanceOf(Target);
  });
});

// ── Union resolution ─────────────────────────────────────────────────────────

describe("resolveUnion — first registered member wins", () => {
  test("first member wins when both are registered", () => {
    class Consumer {
      public constructor(public readonly cache: unknown) {}
    }
    defineDeps(Consumer, [[union(T.A, T.B)]]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.A, RedisImpl).as("singleton");
    services.add(T.B, MemoryCacheImpl).as("singleton");
    services.add(T.Service, Consumer).as("singleton");

    const c = services.build().resolve<Consumer>(T.Service);
    expect(c.cache).toBeInstanceOf(RedisImpl); // first member = T.A wins
  });

  test("falls through to second member when first is unregistered", () => {
    class Consumer {
      public constructor(public readonly cache: unknown) {}
    }
    defineDeps(Consumer, [[union(T.A, T.B)]]);

    const services = new ServiceManifest<"singleton">();
    // T.A deliberately NOT registered — fallthrough to T.B.
    services.add(T.B, MemoryCacheImpl).as("singleton");
    services.add(T.Service, Consumer).as("singleton");

    const c = services.build().resolve<Consumer>(T.Service);
    expect(c.cache).toBeInstanceOf(MemoryCacheImpl);
  });

  test("exhaustion — all union members unregistered — throws NoSatisfiableSignatureError when no fallback", () => {
    // When all members of a union slot are unregistered, selectSignature deems
    // the containing signature unsatisfiable. With no other overload to fall
    // back to, NoSatisfiableSignatureError is thrown.
    class Consumer {
      public constructor(public readonly cache: unknown) {}
    }
    defineDeps(Consumer, [[union(T.A, T.B)]]);

    const services = new ServiceManifest<"singleton">();
    // Neither T.A nor T.B registered.
    services.add(T.Service, Consumer).as("singleton");

    const root = services.build();
    expect(() => root.resolve(T.Service)).toThrow(NoSatisfiableSignatureError);
  });

  test("NoSatisfiableUnionError is thrown during buildPartitioned when union is exhausted", () => {
    // buildPartitioned (the factory target path) uses selectTargetSignature which
    // does NOT gate on resolvability. If a union member is unregistered at call time,
    // resolveUnion fires and throws NoSatisfiableUnionError.
    const T_UNION_A = "test:union:A" as const;
    const T_UNION_B = "test:union:B" as const;
    const T_CALLER = "test:union:caller" as const;

    class Target {
      public constructor(
        public readonly cache: unknown,
        public readonly caller: unknown,
      ) {}
    }
    // Signature: [union(T_UNION_A, T_UNION_B), T_CALLER].
    // T_CALLER is the caller-supplied param; the union slot has no registered members.
    defineDeps(Target, [[union(T_UNION_A, T_UNION_B), T_CALLER]]);

    class Holder {
      public constructor(public readonly make: (x: unknown) => Target) {}
    }
    // FactoryRef with params — factory shape: (caller: unknown) => Target.
    const ref: FactoryRef = { type: T.Service, params: [T_CALLER] };
    defineDeps(Holder, [[ref]]);

    const services = new ServiceManifest<"singleton">();
    // Neither T_UNION_A nor T_UNION_B registered — union is exhausted at call time.
    services.add(T.Service, Target).as("singleton");
    services.add(T.Repo, Holder).as("singleton");

    const holder = services.build().resolve<Holder>(T.Repo);
    expect(() => holder.make("x")).toThrow(NoSatisfiableUnionError);
  });

  test("NoSatisfiableUnionError includes the member list", () => {
    const T_UNION_A = "test:union:members:A" as const;
    const T_UNION_B = "test:union:members:B" as const;
    const T_CALLER = "test:union:members:caller" as const;

    class Target {
      public constructor(
        public readonly cache: unknown,
        public readonly caller: unknown,
      ) {}
    }
    defineDeps(Target, [[union(T_UNION_A, T_UNION_B), T_CALLER]]);

    class Holder {
      public constructor(public readonly make: (x: unknown) => Target) {}
    }
    const ref: FactoryRef = { type: T.Service, params: [T_CALLER] };
    defineDeps(Holder, [[ref]]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.Service, Target).as("singleton");
    services.add(T.Repo, Holder).as("singleton");

    const holder = services.build().resolve<Holder>(T.Repo);
    try {
      holder.make("x");
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NoSatisfiableUnionError);
      const e = err as NoSatisfiableUnionError;
      expect(e.members).toContain(T_UNION_A);
      expect(e.members).toContain(T_UNION_B);
    }
  });

  test("union slot in a multi-slot signature resolves alongside other token slots", () => {
    class Consumer {
      public constructor(
        public readonly cache: unknown,
        public readonly log: unknown,
      ) {}
    }
    // First slot: union of T.A / T.B; second slot: T.Logger (plain token).
    defineDeps(Consumer, [[union(T.A, T.B), T.Logger]]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.A, RedisImpl).as("singleton");
    services.add(T.Logger, LoggerImpl).as("singleton");
    services.add(T.Service, Consumer).as("singleton");

    const c = services.build().resolve<Consumer>(T.Service);
    expect(c.cache).toBeInstanceOf(RedisImpl);
    expect(c.log).toBeInstanceOf(LoggerImpl);
  });
});

// ── Union satisfiability in selectSignature ──────────────────────────────────

describe("Union satisfiability in selectSignature", () => {
  test("a signature with a Union slot is satisfiable when at least one member is registered", () => {
    // Two overloads: [union(A, B), Logger] and [Logger].
    // Only T.B and Logger are registered; the union slot is satisfied by T.B.
    class Svc {
      public readonly args: unknown[];
      public constructor(...args: unknown[]) {
        this.args = args;
      }
    }
    defineDeps(Svc, [
      [union(T.A, T.B), T.Logger],
      [T.Logger],
    ]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.B, MemoryCacheImpl).as("singleton");
    services.add(T.Logger, LoggerImpl).as("singleton");
    services.add(T.Service, Svc).as("singleton");

    const svc = services.build().resolve<Svc>(T.Service);
    // Longest satisfiable signature wins.
    expect(svc.args).toHaveLength(2);
    expect(svc.args[0]).toBeInstanceOf(MemoryCacheImpl); // union resolved to T.B
    expect(svc.args[1]).toBeInstanceOf(LoggerImpl);
  });

  test("a signature with a Union slot is unsatisfiable when NO member is registered — falls to shorter overload", () => {
    class Svc {
      public readonly args: unknown[];
      public constructor(...args: unknown[]) {
        this.args = args;
      }
    }
    // [union(A, B), Logger]: union unsatisfiable (neither registered) → skip.
    // [Logger]: satisfiable.
    defineDeps(Svc, [
      [union(T.A, T.B), T.Logger],
      [T.Logger],
    ]);

    const services = new ServiceManifest<"singleton">();
    // Neither T.A nor T.B registered.
    services.add(T.Logger, LoggerImpl).as("singleton");
    services.add(T.Service, Svc).as("singleton");

    const svc = services.build().resolve<Svc>(T.Service);
    expect(svc.args).toHaveLength(1);
    expect(svc.args[0]).toBeInstanceOf(LoggerImpl);
  });

  test("all-union-unsatisfiable with no fallback overload → NoSatisfiableSignatureError", () => {
    class Svc {
      public constructor(public readonly x: unknown) {}
    }
    defineDeps(Svc, [[union(T.A, T.B)]]);

    const services = new ServiceManifest<"singleton">();
    // Neither registered.
    services.add(T.Service, Svc).as("singleton");

    const root = services.build();
    expect(() => root.resolve(T.Service)).toThrow(NoSatisfiableSignatureError);
  });
});

// ── Single-member unions (ported from #34 anyof gaps) ────────────────────────

describe("single-member union", () => {
  test("GAP1: single-member union, member unregistered → NoSatisfiableSignatureError (never null)", () => {
    // A one-member union with no registered member makes the signature
    // unsatisfiable — resolution throws, it never injects null/undefined.
    class Svc {
      public constructor(public readonly dep: unknown) {}
    }
    defineDeps(Svc, [[union(T.A)]]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.Service, Svc).as("singleton");

    expect(() => services.build().resolve(T.Service)).toThrow(
      NoSatisfiableSignatureError,
    );
  });

  test("GAP8: single-member union happy path — member registered, resolves", () => {
    class ImplA {
      public readonly kind = "impl-a";
    }
    class Svc {
      public constructor(public readonly dep: unknown) {}
    }
    defineDeps(Svc, [[union(T.A)]]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.A, ImplA).as("singleton");
    services.add(T.Service, Svc).as("singleton");

    expect((services.build().resolve<Svc>(T.Service).dep as ImplA).kind).toBe(
      "impl-a",
    );
  });
});

// ── Union member composability (ported from #34 anyof gaps) ──────────────────

describe("union member composability", () => {
  test("GAP2: a member that THROWS at build time falls through to the next", () => {
    // T.A is registered (so it passes the static resolvability check) but its
    // own ctor needs an UNREGISTERED dep, so building it throws. The union
    // catches that and falls through to T.B (transient — always resolvable).
    // (Note: under the uniform-tag model a tagged member with no open frame does
    // NOT throw — it resolves transiently — so a genuine build failure is needed
    // to exercise fallthrough; an unsatisfiable ctor dep is one such failure.)
    class NeedsMissing {
      public readonly kind = "needs-missing";
      public constructor(public readonly missing: unknown) {}
    }
    class TransientB {
      public readonly kind = "transient-b";
    }
    class Svc {
      public constructor(public readonly dep: unknown) {}
    }
    defineDeps(NeedsMissing, [["union:unregistered-dep"]]);
    defineDeps(Svc, [[union(T.A, T.B)]]);

    const services = new ServiceManifest<"singleton" | "request">();
    services.add(T.A, NeedsMissing); // registered, but its ctor dep is not
    services.add(T.B, TransientB); // transient — always resolvable
    services.add(T.Service, Svc);

    // T.A is statically resolvable (registered) so the union tries it; building
    // it throws (its "union:unregistered-dep" ctor dep is absent) → fall through to B.
    const svc = services.build().resolve<Svc>(T.Service);
    expect((svc.dep as TransientB).kind).toBe("transient-b");
  });

  test("GAP3: FactoryRef member resolves when its target is registered", () => {
    class TargetClass {
      public readonly kind = "factory-target";
    }
    class Svc {
      public constructor(public readonly dep: unknown) {}
    }
    // union({ type: T.A }, T.B): factory-target registered → factory callable wins.
    defineDeps(Svc, [[union({ type: T.A }, T.B)]]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.A, TargetClass).as("singleton");
    // T.B NOT registered — the FactoryRef member is always satisfiable, wins.
    services.add(T.Service, Svc).as("singleton");

    const svc = services.build().resolve<Svc>(T.Service);
    expect(typeof svc.dep).toBe("function");
    expect((svc.dep as () => TargetClass)()).toBeInstanceOf(TargetClass);
  });

  test("GAP4: FactoryRef member target-unregistered — falls to next member", () => {
    // A FactoryRef whose TARGET is unregistered is NOT resolvable (isResolvableSlot
    // walks to the target token), so the union falls through to T.B.
    class FallbackB {
      public readonly kind = "fallback-b";
    }
    class Svc {
      public constructor(public readonly dep: unknown) {}
    }
    defineDeps(Svc, [[union({ type: T.A }, T.B)]]);

    const services = new ServiceManifest<"singleton">();
    // T.A NOT registered → FactoryRef member not resolvable.
    services.add(T.B, FallbackB).as("singleton");
    services.add(T.Service, Svc).as("singleton");

    const svc = services.build().resolve<Svc>(T.Service);
    expect((svc.dep as FallbackB).kind).toBe("fallback-b");
  });

  test("GAP5: ScopeRef member is always resolvable and wins over later members", () => {
    class FallbackB {
      public readonly kind = "fallback-b";
    }
    class Svc {
      public constructor(public readonly dep: unknown) {}
    }
    // union({ scope: true }, T.B): ScopeRef is always resolvable → wins.
    defineDeps(Svc, [[union({ scope: true }, T.B)]]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.B, FallbackB).as("singleton");
    services.add(T.Service, Svc).as("singleton");

    const svc = services.build().resolve<Svc>(T.Service);
    // The dep is the live provider view (has resolve + createScope methods).
    expect(typeof (svc.dep as { resolve?: unknown }).resolve).toBe("function");
  });

  test("GAP6: nested union resolves when it is itself a member of an outer union", () => {
    class ImplA {
      public readonly kind = "impl-a";
    }
    class Svc {
      public constructor(public readonly dep: unknown) {}
    }
    // union(union(T.A), T.B): inner union has T.A registered → resolves.
    defineDeps(Svc, [[union(union(T.A), T.B)]]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.A, ImplA).as("singleton");
    services.add(T.Service, Svc).as("singleton");

    const svc = services.build().resolve<Svc>(T.Service);
    expect((svc.dep as ImplA).kind).toBe("impl-a");
  });

  test("GAP7: a fully-unsatisfiable union surfaces its member tokens in the error", () => {
    // selectSignature marks a union-only signature unsatisfiable when no member
    // is registered, and NoSatisfiableSignatureError carries the union's tokens.
    class Svc {
      public constructor(_dep: unknown) {}
    }
    defineDeps(Svc, [[union(T.A, T.B)]]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.Service, Svc).as("singleton");

    let caught: NoSatisfiableSignatureError | undefined;
    try {
      services.build().resolve(T.Service);
    } catch (e) {
      if (e instanceof NoSatisfiableSignatureError) {caught = e;}
    }
    expect(caught).toBeDefined();
    expect(caught!.unsatisfiable).toContain(T.A);
    expect(caught!.unsatisfiable).toContain(T.B);
  });
});

// ── Runtime regression pins ──────────────────────────────────────────────────

describe("union runtime regression pins", () => {
  test("single declared overload — union(A,B) with only first member registered resolves via A", () => {
    // Mirrors: a class with one declared overload whose parameter is a union(A,B),
    // only T.A registered. The union resolves to A (first member wins).
    class Consumer {
      public constructor(public readonly dep: unknown) {}
    }
    // One overload: [union(T.A, T.B)].
    defineDeps(Consumer, [[union(T.A, T.B)]]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.A, RedisImpl).as("singleton");
    // T.B NOT registered.
    services.add(T.Service, Consumer).as("singleton");

    const c = services.build().resolve<Consumer>(T.Service);
    expect(c.dep).toBeInstanceOf(RedisImpl);
  });

  test("union falls through to 2nd member; adjacent plain token slot resolves normally", () => {
    // A signature with two slots: [union(T.A, T.B), T.Logger]. T.A is NOT
    // registered — union falls through to T.B. T.Logger (plain token, adjacent
    // slot) resolves independently and normally.
    class Consumer {
      public constructor(
        public readonly cache: unknown,
        public readonly log: unknown,
      ) {}
    }
    defineDeps(Consumer, [[union(T.A, T.B), T.Logger]]);

    const services = new ServiceManifest<"singleton">();
    // T.A NOT registered — fallthrough to T.B.
    services.add(T.B, MemoryCacheImpl).as("singleton");
    services.add(T.Logger, LoggerImpl).as("singleton");
    services.add(T.Service, Consumer).as("singleton");

    const c = services.build().resolve<Consumer>(T.Service);
    expect(c.cache).toBeInstanceOf(MemoryCacheImpl);
    expect(c.log).toBeInstanceOf(LoggerImpl);
  });

  test("`IFoo | 'fallback'` — IFoo unregistered → string literal injected", () => {
    // A union whose first member is a token (T.A) and second is a LiteralRef
    // string value. With T.A unregistered, the LiteralRef wins.
    class Consumer {
      public constructor(public readonly dep: unknown) {}
    }
    defineDeps(Consumer, [[union(T.A, { value: "fallback" })]]);

    const services = new ServiceManifest<"singleton">();
    // T.A NOT registered — falls through to the LiteralRef.
    services.add(T.Service, Consumer).as("singleton");

    expect(services.build().resolve<Consumer>(T.Service).dep).toBe("fallback");
  });
});

// ── resolveFactory(type, params) ─────────────────────────────────────────────

describe("ServiceProvider.resolveFactory(type, params)", () => {
  test("no params — strict zero-arg factory, every slot resolves from container", () => {
    class Target {
      public static built = 0;
      public constructor(public readonly dep: LoggerImpl) {
        Target.built += 1;
      }
    }
    Target.built = 0;
    defineDeps(Target, [[T.Logger]]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.Logger, LoggerImpl).as("singleton");
    services.add(T.Service, Target).as("singleton");

    const root = services.build().createScope("singleton");
    // resolveFactory with NO params → zero-arg factory.
    const make = root.resolveFactory(T.Service) as () => Target;
    expect(typeof make).toBe("function");
    const a = make();
    expect(a).toBeInstanceOf(Target);
    // Singleton lifetime is respected — same instance across calls.
    const b = make();
    expect(a).toBe(b);
    expect(Target.built).toBe(1);
  });

  test("params present — caller supplies named param, container resolves the rest", () => {
    const T_NAME = "test:resolveFactory:name" as const;

    class Greeter {
      public static built = 0;
      public constructor(
        public readonly log: LoggerImpl,
        public readonly name: string,
      ) {
        Greeter.built += 1;
      }
    }
    Greeter.built = 0;
    defineDeps(Greeter, [[T.Logger, T_NAME]]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.Logger, LoggerImpl).as("singleton");
    services.add(T.Service, Greeter).as("singleton");
    // T_NAME NOT registered — caller-supplied.

    const root = services.build();
    // resolveFactory WITH params — factory shape is (name: string) => Greeter.
    const make = root.resolveFactory(T.Service, [T_NAME]) as (name: string) => Greeter;
    expect(typeof make).toBe("function");

    const ann = make("ann");
    expect(ann).toBeInstanceOf(Greeter);
    expect(ann.log).toBeInstanceOf(LoggerImpl);
    expect(ann.name).toBe("ann");

    const bob = make("bob");
    expect(bob.name).toBe("bob");
    expect(ann).not.toBe(bob); // fresh instance per call
    expect(Greeter.built).toBe(2);
  });

  test("params present — caller claims a registered slot (override: caller wins)", () => {
    const T_CUSTOM_LOGGER = "test:resolveFactory:customLogger" as const;

    class Target {
      public constructor(public readonly log: unknown) {}
    }
    defineDeps(Target, [[T.Logger]]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.Logger, LoggerImpl).as("singleton"); // registered
    services.add(T.Service, Target).as("singleton");

    const root = services.build();
    // T.Logger IS registered but we name it in params → caller wins.
    const make = root.resolveFactory(T.Service, [T.Logger]) as (log: unknown) => Target;

    const customLog = { custom: true };
    const t = make(customLog);
    expect(t.log).toBe(customLog); // caller-supplied, not the container's LoggerImpl
  });

  test("params present — a slot neither claimed nor resolvable → error", () => {
    const T_MISSING = "test:resolveFactory:missing" as const;

    class Target {
      public constructor(
        public readonly log: LoggerImpl,
        public readonly dep: unknown,
      ) {}
    }
    defineDeps(Target, [[T.Logger, T_MISSING]]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.Logger, LoggerImpl).as("singleton");
    services.add(T.Service, Target).as("singleton");
    // T_MISSING NOT registered and NOT in params.

    const root = services.build();
    // params only claims T.Logger; T_MISSING is neither claimed nor registered.
    const make = root.resolveFactory(T.Service, [T.Logger]) as (log: unknown) => Target;

    // Calling the factory should throw because T_MISSING has no source.
    expect(() => make(new LoggerImpl())).toThrow();
  });

  test("params present — authored order matches call arg order", () => {
    const T_B = "test:resolveFactory:b" as const;
    const T_D = "test:resolveFactory:d" as const;

    class Wide {
      public readonly args: unknown[];
      public constructor(...args: unknown[]) {
        this.args = args;
      }
    }
    // Signature: [T.A, T_B, T.B, T_D, T.C].
    defineDeps(Wide, [[T.A, T_B, T.B, T_D, T.C]]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.A, class A {}).as("singleton");
    services.add(T.B, class B {}).as("singleton");
    services.add(T.C, class C {}).as("singleton");
    services.add(T.Service, Wide).as("singleton");
    // T_B and T_D NOT registered.

    const root = services.build();
    // Authored-order params list: [T_B, T_D].
    const make = root.resolveFactory(T.Service, [T_B, T_D]) as (b: unknown, d: unknown) => Wide;
    const w = make("BB", "DD");

    expect(w.args).toHaveLength(5);
    expect((w.args[0] as { constructor: { name: string } }).constructor.name).toBe("A");
    expect(w.args[1]).toBe("BB"); // T_B ← first call arg
    expect((w.args[2] as { constructor: { name: string } }).constructor.name).toBe("B");
    expect(w.args[3]).toBe("DD"); // T_D ← second call arg
    expect((w.args[4] as { constructor: { name: string } }).constructor.name).toBe("C");
  });
});
