import { test, expect, describe } from "bun:test";
import { DiBuilder, FactoryTargetError } from "@fnioc/di";
import { defineDeps, hole } from "@fnioc/core";
import type { FactoryRef } from "@fnioc/core";
import { T } from "./fixtures.js";

// Factory injection + hole filling (Phase 2D.2).
//
// A `FactoryRef` slot is injected as a CALLABLE that builds its target on
// demand; a `null` hole is a caller-supplied parameter filled positionally at
// factory-call time. The engine partitions the target ctor's signature against
// the LIVE registration map at call time — registered token → resolve, hole or
// unregistered token → next caller arg.
//
// Lifetime: a bare zero-arg factory routes through the normal resolve path and
// respects the target's registered lifetime; a parameterized factory builds a
// fresh instance every call (caller args differ per call ⇒ no caching).

// A `FactoryRef` literal — the ABI shape the transformer emits for a factory
// parameter (`{ factory: <token> }`).
function factoryOf(token: string): FactoryRef {
  return { factory: token };
}

// ── Targets ───────────────────────────────────────────────────────────────

/** Zero-arg target — counts its own constructions. */
class Foo {
  public static built = 0;
  public readonly id: number;
  public constructor() {
    Foo.built += 1;
    this.id = Foo.built;
  }
}

/** A registered dependency the partition resolves rather than asks the caller for. */
class Dep {
  public readonly kind = "dep";
}

describe("bare zero-arg factory", () => {
  test("respects a singleton target's lifetime — same instance every call", () => {
    Foo.built = 0;
    // Holder ctor: (makeFoo: () => Foo). The slot is a FactoryRef of Foo.
    class Holder {
      public constructor(public readonly makeFoo: () => Foo) {}
    }
    defineDeps(Holder, [[factoryOf(T.Service)]]);

    const services = new DiBuilder<"singleton">();
    services.add(T.Service, Foo).as("singleton"); // Foo is a singleton
    services.add(T.Repo, Holder).as("singleton");

    const holder = services.createScope("singleton").resolve<Holder>(T.Repo);

    const a = holder.makeFoo();
    const b = holder.makeFoo();
    expect(a).toBeInstanceOf(Foo);
    expect(a).toBe(b); // singleton ⇒ one shared instance across factory calls
    expect(Foo.built).toBe(1);
  });

  test("yields a fresh instance each call for a transient target", () => {
    Foo.built = 0;
    class Holder {
      public constructor(public readonly makeFoo: () => Foo) {}
    }
    defineDeps(Holder, [[factoryOf(T.Service)]]);

    const services = new DiBuilder<"singleton">();
    services.add(T.Service, Foo); // untagged ⇒ transient
    services.add(T.Repo, Holder).as("singleton");

    const holder = services.createScope("singleton").resolve<Holder>(T.Repo);

    const a = holder.makeFoo();
    const b = holder.makeFoo();
    expect(a).not.toBe(b); // transient ⇒ fresh every call
    expect(Foo.built).toBe(2);
  });
});

describe("parameterized factory", () => {
  test("fills a hole positionally and builds a fresh instance per call", () => {
    // Target ctor: (dep: Dep, name: string). `name` is a hole (caller-supplied).
    class Greeter {
      public static built = 0;
      public constructor(
        public readonly dep: Dep,
        public readonly name: string,
      ) {
        Greeter.built += 1;
      }
    }
    Greeter.built = 0;
    defineDeps(Greeter, [[T.A, hole]]);

    class Holder {
      public constructor(public readonly make: (name: string) => Greeter) {}
    }
    defineDeps(Holder, [[factoryOf(T.Service)]]);

    const services = new DiBuilder<"singleton">();
    services.add(T.A, Dep).as("singleton");
    services.add(T.Service, Greeter).as("singleton"); // tag is irrelevant — parameterized bypasses the cache
    services.add(T.Repo, Holder).as("singleton");

    const holder = services.createScope("singleton").resolve<Holder>(T.Repo);

    const ann = holder.make("ann");
    const bob = holder.make("bob");

    expect(ann.dep).toBeInstanceOf(Dep);
    expect(ann.name).toBe("ann");
    expect(bob.name).toBe("bob");
    expect(ann).not.toBe(bob); // fresh per call despite the singleton tag
    expect(Greeter.built).toBe(2);
  });

  test("mixed registered+hole partition keeps caller args in relative order", () => {
    // Target ctor: (a: IA, b: B2, c: IC, d: D4, e: IE). IA/IC/IE registered;
    // B2 and D4 are holes (caller-supplied). The injected callable exposes only
    // the holes in order: (b, d). At call: new T(resolve(A), b, resolve(C), d, resolve(E)).
    class Wide {
      public readonly args: unknown[];
      public constructor(...args: unknown[]) {
        this.args = args;
      }
    }
    defineDeps(Wide, [[T.A, hole, T.B, hole, T.C]]);

    class Holder {
      public constructor(
        public readonly make: (b: unknown, d: unknown) => Wide,
      ) {}
    }
    defineDeps(Holder, [[factoryOf(T.Service)]]);

    const services = new DiBuilder<"singleton">();
    // A, B, C registered (standing in for IA/IC/IE); the two holes are caller args.
    services.add(T.A, class A {}).as("singleton");
    services.add(T.B, class B {}).as("singleton");
    services.add(T.C, class C {}).as("singleton");
    services.add(T.Service, Wide).as("singleton");
    services.add(T.Repo, Holder).as("singleton");

    const holder = services.createScope("singleton").resolve<Holder>(T.Repo);
    const w = holder.make("BB", "DD");

    expect(w.args).toHaveLength(5);
    // Registered slots resolved; holes filled from caller args in order.
    expect((w.args[0] as { constructor: { name: string } }).constructor.name).toBe("A");
    expect(w.args[1]).toBe("BB"); // first hole ⇐ first caller arg
    expect((w.args[2] as { constructor: { name: string } }).constructor.name).toBe("B");
    expect(w.args[3]).toBe("DD"); // second hole ⇐ second caller arg
    expect((w.args[4] as { constructor: { name: string } }).constructor.name).toBe("C");
  });

  test("an unregistered token slot is treated as caller-supplied too", () => {
    // Target ctor: (dep: Dep, extra: Extra). Dep is registered; T.Db is a real
    // token but NOT in the container ⇒ caller-supplied at call time.
    class Pair {
      public constructor(
        public readonly dep: Dep,
        public readonly extra: unknown,
      ) {}
    }
    defineDeps(Pair, [[T.A, T.Db]]); // T.Db unregistered ⇒ caller arg

    class Holder {
      public constructor(public readonly make: (extra: unknown) => Pair) {}
    }
    defineDeps(Holder, [[factoryOf(T.Service)]]);

    const services = new DiBuilder<"singleton">();
    services.add(T.A, Dep).as("singleton");
    services.add(T.Service, Pair).as("singleton");
    // T.Db deliberately NOT registered.
    services.add(T.Repo, Holder).as("singleton");

    const holder = services.createScope("singleton").resolve<Holder>(T.Repo);
    const p = holder.make("supplied");

    expect(p.dep).toBeInstanceOf(Dep);
    expect(p.extra).toBe("supplied");
  });
});

describe("§5.4 — owning-scope rule holds for factory targets", () => {
  test("a singleton-held factory of a request-scoped target throws at call time", () => {
    // Foo is request-scoped. Holder is a singleton, so it OWNS its factory; the
    // factory builds Foo relative to the singleton's chain, which has no
    // request ancestor ⇒ MissingScopeError when the factory is called.
    Foo.built = 0;
    class Holder {
      public constructor(public readonly makeFoo: () => Foo) {}
    }
    defineDeps(Holder, [[factoryOf(T.Service)]]);

    const services = new DiBuilder<"singleton" | "request">();
    services.add(T.Service, Foo).as("request"); // request-scoped target
    services.add(T.Repo, Holder).as("singleton"); // singleton holds the factory

    const root = services.createScope("singleton");
    const req = root.createScope("request");

    // Resolve the holder FROM a request scope — but the holder is a singleton,
    // owned by root. Its factory captures the singleton scope. Calling it tries
    // to build a request-scoped Foo with no request ancestor ⇒ throw.
    const holder = req.resolve<Holder>(T.Repo);
    expect(() => holder.makeFoo()).toThrow(/lifetime is tagged "request"/);
  });

  test("a request-held factory of a request-scoped target resolves fine", () => {
    Foo.built = 0;
    class Holder {
      public constructor(public readonly makeFoo: () => Foo) {}
    }
    defineDeps(Holder, [[factoryOf(T.Service)]]);

    const services = new DiBuilder<"singleton" | "request">();
    services.add(T.Service, Foo).as("request");
    services.add(T.Repo, Holder).as("request"); // holder is request-scoped now

    const req = services.createScope("singleton").createScope("request");
    const holder = req.resolve<Holder>(T.Repo);

    const a = holder.makeFoo();
    expect(a).toBeInstanceOf(Foo);
  });
});

describe("factory target errors", () => {
  test("clear error when the factory token is unregistered", () => {
    class Holder {
      public constructor(public readonly makeFoo: () => Foo) {}
    }
    defineDeps(Holder, [[factoryOf(T.Service)]]);

    const services = new DiBuilder<"singleton">();
    // T.Service (the factory target) deliberately NOT registered.
    services.add(T.Repo, Holder).as("singleton");

    const root = services.createScope("singleton");
    expect(() => root.resolve<Holder>(T.Repo)).toThrow(FactoryTargetError);
    try {
      root.resolve<Holder>(T.Repo);
    } catch (err) {
      const e = err as FactoryTargetError;
      expect(e.factoryToken).toBe(T.Service);
      expect(e.reason).toBe("unregistered");
    }
  });

  test("clear error when the factory target is a useValue, not a class", () => {
    class Holder {
      public constructor(public readonly makeFoo: () => Foo) {}
    }
    defineDeps(Holder, [[factoryOf(T.Service)]]);

    const services = new DiBuilder<"singleton">();
    services.register(T.Service, { useValue: new Foo() }); // not a class registration
    services.add(T.Repo, Holder).as("singleton");

    const root = services.createScope("singleton");
    expect(() => root.resolve<Holder>(T.Repo)).toThrow(FactoryTargetError);
    try {
      root.resolve<Holder>(T.Repo);
    } catch (err) {
      const e = err as FactoryTargetError;
      expect(e.reason).toBe("not-a-class");
    }
  });
});
