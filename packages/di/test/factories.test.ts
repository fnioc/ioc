import { test, expect, describe } from "bun:test";
import { DiBuilder, FactoryTargetError } from "@fnioc/di";
import { defineDeps } from "@fnioc/core";
import type { FactoryRef } from "@fnioc/core";
import { T } from "./fixtures.js";

// Factory injection + caller-supplied params.
//
// A `FactoryRef` slot is injected as a CALLABLE that builds its target on
// demand. When `params` is absent/empty, the factory is a strict zero-arg `()
// => T` — every ctor slot must resolve from the container. When `params` is
// present, it is the complete authored-order list of caller-supplied parameter
// tokens; the factory shape is `(...params) => T`.
//
// Lifetime: a bare zero-arg factory routes through the normal resolve path and
// respects the target's registered lifetime; a parameterized factory builds a
// fresh instance every call (caller args differ per call ⇒ no caching).

// A `FactoryRef` literal — the ABI shape the transformer emits for a factory
// parameter (`{ type: <token>, params?: [...] }`).
function factoryOf(token: string, params?: readonly string[]): FactoryRef {
  return params !== undefined ? { type: token, params } : { type: token };
}

// Tokens for caller-supplied slots (never registered in the container).
const T_NAME = "test:name" as const;
const T_B2 = "test:B2" as const;
const T_D4 = "test:D4" as const;
const T_EXTRA = "test:extra" as const;

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

    const holder = services.build().resolve<Holder>(T.Repo);

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

    const holder = services.build().resolve<Holder>(T.Repo);

    const a = holder.makeFoo();
    const b = holder.makeFoo();
    expect(a).not.toBe(b); // transient ⇒ fresh every call
    expect(Foo.built).toBe(2);
  });
});

describe("parameterized factory", () => {
  test("fills caller-supplied params by token and builds a fresh instance per call", () => {
    // Target ctor: (dep: Dep, name: string). T_NAME is caller-supplied via params.
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
    defineDeps(Greeter, [[T.A, T_NAME]]);

    class Holder {
      public constructor(public readonly make: (name: string) => Greeter) {}
    }
    // FactoryRef with params — the factory exposes T_NAME as its single arg.
    defineDeps(Holder, [[factoryOf(T.Service, [T_NAME])]]);

    const services = new DiBuilder<"singleton">();
    services.add(T.A, Dep).as("singleton");
    services.add(T.Service, Greeter).as("singleton"); // tag irrelevant — parameterized bypasses cache
    // T_NAME deliberately NOT registered; it is caller-supplied.
    services.add(T.Repo, Holder).as("singleton");

    const holder = services.build().resolve<Holder>(T.Repo);

    const ann = holder.make("ann");
    const bob = holder.make("bob");

    expect(ann.dep).toBeInstanceOf(Dep);
    expect(ann.name).toBe("ann");
    expect(bob.name).toBe("bob");
    expect(ann).not.toBe(bob); // fresh per call despite the singleton tag
    expect(Greeter.built).toBe(2);
  });

  test("mixed registered+caller-supplied params keeps args in authored order", () => {
    // Target ctor: (a: IA, b: B2, c: IC, d: D4, e: IE). IA/IC/IE registered;
    // T_B2 and T_D4 are caller-supplied via params. The factory exposes them in
    // authored order: (b, d). At call: new T(resolve(A), b, resolve(C), d, resolve(E)).
    class Wide {
      public readonly args: unknown[];
      public constructor(...args: unknown[]) {
        this.args = args;
      }
    }
    defineDeps(Wide, [[T.A, T_B2, T.B, T_D4, T.C]]);

    class Holder {
      public constructor(
        public readonly make: (b: unknown, d: unknown) => Wide,
      ) {}
    }
    // Factory params list = [T_B2, T_D4] — authored order is the call arg order.
    defineDeps(Holder, [[factoryOf(T.Service, [T_B2, T_D4])]]);

    const services = new DiBuilder<"singleton">();
    services.add(T.A, class A {}).as("singleton");
    services.add(T.B, class B {}).as("singleton");
    services.add(T.C, class C {}).as("singleton");
    services.add(T.Service, Wide).as("singleton");
    // T_B2 and T_D4 NOT registered — caller-supplied.
    services.add(T.Repo, Holder).as("singleton");

    const holder = services.build().resolve<Holder>(T.Repo);
    const w = holder.make("BB", "DD");

    expect(w.args).toHaveLength(5);
    expect((w.args[0] as { constructor: { name: string } }).constructor.name).toBe("A");
    expect(w.args[1]).toBe("BB"); // first caller param ⇐ first call arg
    expect((w.args[2] as { constructor: { name: string } }).constructor.name).toBe("B");
    expect(w.args[3]).toBe("DD"); // second caller param ⇐ second call arg
    expect((w.args[4] as { constructor: { name: string } }).constructor.name).toBe("C");
  });

  test("a caller param that is also registered — caller wins (override)", () => {
    // T.A is registered, but T.A is also named in params — caller wins.
    class Pair {
      public constructor(
        public readonly dep: Dep,
        public readonly extra: unknown,
      ) {}
    }
    defineDeps(Pair, [[T.A, T_EXTRA]]);

    class Holder {
      public constructor(public readonly make: (dep: unknown, extra: unknown) => Pair) {}
    }
    // Both T.A and T_EXTRA are listed as caller params.
    defineDeps(Holder, [[factoryOf(T.Service, [T.A, T_EXTRA])]]);

    const services = new DiBuilder<"singleton">();
    services.add(T.A, Dep).as("singleton"); // registered, but params claim it
    services.add(T.Service, Pair).as("singleton");
    // T_EXTRA NOT registered.
    services.add(T.Repo, Holder).as("singleton");

    const holder = services.build().resolve<Holder>(T.Repo);
    const p = holder.make("caller-dep", "caller-extra");

    // T.A is in params → caller-supplied, not resolved from container.
    expect(p.dep).toBe("caller-dep");
    expect(p.extra).toBe("caller-extra");
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

    const services = new DiBuilder<"singleton", "request">();
    services.add(T.Service, Foo).as("request"); // request-scoped target
    services.add(T.Repo, Holder).as("singleton"); // singleton holds the factory

    const root = services.build();
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

    const services = new DiBuilder<"singleton", "request">();
    services.add(T.Service, Foo).as("request");
    services.add(T.Repo, Holder).as("request"); // holder is request-scoped now

    const req = services.build().createScope("request");
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

    const root = services.build();
    expect(() => root.resolve<Holder>(T.Repo)).toThrow(FactoryTargetError);
    try {
      root.resolve<Holder>(T.Repo);
    } catch (err) {
      const e = err as FactoryTargetError;
      expect(e.factoryToken).toBe(T.Service);
      expect(e.reason).toBe("unregistered");
    }
  });

  test("a FactoryRef targeting a value registration yields a thunk returning the value", () => {
    // Semantic change: the old engine threw FactoryTargetError("not-a-class") for
    // a value target. The new engine treats a value target as a zero-arg factory
    // that resolves and returns the stored instance — same identity every call.
    const storedFoo = new Foo();
    class Holder {
      public constructor(public readonly getFoo: () => Foo) {}
    }
    defineDeps(Holder, [[factoryOf(T.Service)]]);

    const services = new DiBuilder<"singleton">();
    services.addValue(T.Service, storedFoo);
    services.add(T.Repo, Holder).as("singleton");

    const root = services.build();
    const holder = root.resolve<Holder>(T.Repo);
    expect(holder.getFoo()).toBe(storedFoo); // thunk returns the exact registered value
    expect(holder.getFoo()).toBe(storedFoo); // same reference every call
  });
});
