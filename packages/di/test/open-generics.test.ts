import { test, expect, describe } from "bun:test";
import {
  ServiceManifest,
  ServiceProvider,
  NoSatisfiableSignatureError,
  OpenTokenRegistrationError,
  OpenTokenResolutionError,
  UnregisteredTokenError,
  closeToken,
  typeArg,
  union,
} from "@fnioc/di";
import type { OpenRegistration, Registration, Resolver, Token } from "@fnioc/di";
import { defineDeps } from "./fixtures.js";
import {
  AsyncDisposableThing,
  DisposeLog,
  G,
  SyncDisposable,
  T,
} from "./fixtures.js";

// Open generics: the runtime engine side. Everything is hand-fed (no
// transformer) — open templates registered as string tokens with holes, closed
// tokens resolved against them. The transformer's lowered output produces
// exactly these calls.

class SqlRepo {
  public constructor(public readonly dep: unknown) {}
}
class MemRepo {
  public constructor(public readonly dep: unknown) {}
}
class ZeroRepo {
  public readonly kind = "zero";
}

describe("open-table matching", () => {
  test("a closed token resolves against an open template, dep substituted", () => {
    const services = new ServiceManifest();
    services.addValue(T.A, "A!");
    services.add(G.RepoTemplate, SqlRepo, [["$1"]]);

    const sp = services.build();
    const repo = sp.resolve<SqlRepo>(G.RepoOfA);

    expect(repo).toBeInstanceOf(SqlRepo);
    expect(repo.dep).toBe("A!");
  });

  test("arity dispatch: <$1> and <$1,$2> are distinct registrations", () => {
    const services = new ServiceManifest();
    services.add("app/IR<$1>", ZeroRepo);
    services.add("app/IR<$1,$2>", MemRepo, [[{ value: "pair" }]]);

    const sp = services.build();

    expect(sp.resolve("app/IR<pkg:IA>")).toBeInstanceOf(ZeroRepo);
    expect(sp.resolve("app/IR<pkg:IA,pkg:IB>")).toBeInstanceOf(MemRepo);
    expect(() => sp.resolve("app/IR<pkg:IA,pkg:IB,pkg:IC>")).toThrow(
      UnregisteredTokenError,
    );
  });

  test("repeated holes match only equal args", () => {
    const services = new ServiceManifest();
    services.add("app/IPair<$1,$1>", ZeroRepo);

    const sp = services.build();

    expect(sp.resolve("app/IPair<pkg:IA,pkg:IA>")).toBeInstanceOf(ZeroRepo);
    expect(() => sp.resolve("app/IPair<pkg:IA,pkg:IB>")).toThrow(
      UnregisteredTokenError,
    );
  });

  test("repeated-hole template registered later wins for equal args; general template still matches unequal", () => {
    const services = new ServiceManifest();
    services.add("app/IPair<$1,$2>", MemRepo, [[{ value: "any" }]]);
    services.add("app/IPair<$1,$1>", ZeroRepo);

    const sp = services.build();

    expect(sp.resolve("app/IPair<pkg:IA,pkg:IA>")).toBeInstanceOf(ZeroRepo);
    expect(sp.resolve("app/IPair<pkg:IA,pkg:IB>")).toBeInstanceOf(MemRepo);
  });

  test("last-wins among identical templates", () => {
    const services = new ServiceManifest();
    services.addValue(T.A, "A!");
    services.add(G.RepoTemplate, SqlRepo, [["$1"]]);
    services.add(G.RepoTemplate, MemRepo, [["$1"]]);

    const sp = services.build();

    expect(sp.resolve(G.RepoOfA)).toBeInstanceOf(MemRepo);
  });

  test("an exact closed registration beats the open fallback", () => {
    const services = new ServiceManifest();
    services.addValue(T.A, "A!");
    services.addValue(T.B, "B!");
    services.add(G.RepoTemplate, SqlRepo, [["$1"]]);
    services.add(G.RepoOfA, MemRepo, [[T.A]]);

    const sp = services.build();

    expect(sp.resolve(G.RepoOfA)).toBeInstanceOf(MemRepo);
    expect(sp.resolve(G.RepoOfB)).toBeInstanceOf(SqlRepo);
  });

  test("a nested closed-generic arg closes recursively through the graph", () => {
    class Box {
      public constructor(public readonly inner: unknown) {}
    }
    const services = new ServiceManifest();
    services.addValue(T.A, "A!");
    services.add("app/IBox<$1>", Box, [["$1"]]);
    services.add(G.RepoTemplate, SqlRepo, [["$1"]]);

    const sp = services.build();
    const repo = sp.resolve<SqlRepo>("pkg:IRepo<app/IBox<pkg:IA>>");

    expect(repo.dep).toBeInstanceOf(Box);
    expect((repo.dep as Box).inner).toBe("A!");
  });

  test("non-generic misses are untouched by the fallback", () => {
    const services = new ServiceManifest();
    services.add(G.RepoTemplate, ZeroRepo);

    const sp = services.build();

    expect(() => sp.resolve(T.Logger)).toThrow(UnregisteredTokenError);
  });
});

describe("substitution across slot kinds", () => {
  test("ScopeRef, LiteralRef, TypeArgRef, hole token, and Union-with-hole all close", () => {
    class KitchenSink {
      public constructor(
        public readonly sp: Resolver,
        public readonly lit: unknown,
        public readonly argToken: unknown,
        public readonly dep: unknown,
        public readonly viaUnion: unknown,
      ) {}
    }
    const services = new ServiceManifest();
    services.addValue(T.A, "A!");
    services.add("app/IKitchen<$1>", KitchenSink, [[
      { scope: true },
      { value: 42 },
      typeArg(1),
      "$1",
      union("app/absent", "$1"),
    ]]);

    const sp = services.build();
    const sink = sp.resolve<KitchenSink>("app/IKitchen<pkg:IA>");

    expect(typeof sink.sp.resolve).toBe("function");
    expect(sink.lit).toBe(42);
    // The TypeArgRef closed into a LiteralRef carrying the arg's TOKEN string.
    expect(sink.argToken).toBe(T.A);
    expect(sink.dep).toBe("A!");
    expect(sink.viaUnion).toBe("A!");
  });

  test("FactoryRef.type and FactoryRef.params holes are substituted", () => {
    class Thing {
      public constructor(public readonly supplied: unknown) {}
    }
    class Consumer {
      public constructor(
        public readonly makeThing: (p: unknown) => Thing,
      ) {}
    }
    const services = new ServiceManifest();
    services.add("app/IThing<$1>", Thing, [["app/IParam<$1>"]]);
    services.add("app/IConsumer<$1>", Consumer, [[
      { type: "app/IThing<$1>", params: ["app/IParam<$1>"] },
    ]]);

    const sp = services.build();
    const consumer = sp.resolve<Consumer>("app/IConsumer<pkg:IA>");
    const thing = consumer.makeThing("hello");

    expect(thing).toBeInstanceOf(Thing);
    expect(thing.supplied).toBe("hello");
  });

  test("holes bind by NUMBER, not position: <$2,$1> inverts", () => {
    class Inverted {
      public constructor(
        public readonly first: unknown,
        public readonly second: unknown,
      ) {}
    }
    const services = new ServiceManifest();
    services.add("app/IInv<$2,$1>", Inverted, [[typeArg(1), typeArg(2)]]);

    const sp = services.build();
    // Template <$2,$1> closed as <pkg:IA,pkg:IB>: $2 = pkg:IA, $1 = pkg:IB.
    const inv = sp.resolve<Inverted>("app/IInv<pkg:IA,pkg:IB>");

    expect(inv.first).toBe(T.B);
    expect(inv.second).toBe(T.A);
  });
});

describe("memoization", () => {
  /** A memo Map that counts `set` calls so re-synthesis is observable. */
  class CountingMap extends Map<Token, Registration> {
    public sets = 0;
    public override set(key: Token, value: Registration): this {
      this.sets += 1;
      return super.set(key, value);
    }
  }

  const openTable = (
    reg: OpenRegistration,
  ): ReadonlyMap<Token, readonly OpenRegistration[]> =>
    new Map([[reg.base, [reg]]]);

  test("repeat resolves reuse the identical synthesized Registration object", () => {
    const memo = new CountingMap();
    const sp = new ServiceProvider(
      new Map(),
      openTable({
        template: G.RepoTemplate,
        base: T.Repo,
        pattern: ["$1"],
        ctor: ZeroRepo,
        scope: undefined,
      }),
      memo,
    );

    sp.resolve(G.RepoOfA);
    const first = memo.get(G.RepoOfA);
    expect(first).toBeDefined();

    sp.resolve(G.RepoOfA);
    expect(memo.get(G.RepoOfA)).toBe(first!);
    expect(memo.sets).toBe(1);
    expect(memo.size).toBe(1);
  });

  test("the memo is shared across scope frames of one provider tree", () => {
    const memo = new CountingMap();
    const sp = new ServiceProvider(
      new Map(),
      openTable({
        template: G.RepoTemplate,
        base: T.Repo,
        pattern: ["$1"],
        ctor: ZeroRepo,
        scope: undefined,
      }),
      memo,
    );

    sp.createScope("one").resolve(G.RepoOfA);
    sp.createScope("two").resolve(G.RepoOfA);

    expect(memo.sets).toBe(1);
  });
});

describe("per-closing scoping", () => {
  test("distinct closings cache distinct singletons; same closing is cached", () => {
    const services = new ServiceManifest();
    services.add(G.RepoTemplate, ZeroRepo).as("singleton");

    const app = services.build().createScope("singleton");
    const a1 = app.resolve(G.RepoOfA);
    const a2 = app.resolve(G.RepoOfA);
    const b = app.resolve(G.RepoOfB);

    expect(a1).toBe(a2);
    expect(b).not.toBe(a1);
    expect(b).toBeInstanceOf(ZeroRepo);
  });

  test("an open registration without .as() is transient per closing", () => {
    const services = new ServiceManifest();
    services.add(G.RepoTemplate, ZeroRepo);

    const app = services.build().createScope("singleton");

    expect(app.resolve(G.RepoOfA)).not.toBe(app.resolve(G.RepoOfA));
  });

  test(".as() appends a scoped COPY — a later transient re-registration wins", () => {
    const services = new ServiceManifest();
    services.add(G.RepoTemplate, ZeroRepo).as("singleton");
    services.add(G.RepoTemplate, MemRepo, [[{ value: "m" }]]);

    const app = services.build().createScope("singleton");
    const r1 = app.resolve(G.RepoOfA);
    const r2 = app.resolve(G.RepoOfA);

    expect(r1).toBeInstanceOf(MemRepo);
    expect(r1).not.toBe(r2);
  });

  test("closed registrations follow the owner-relative captive-dependency rule", () => {
    class Dep {}
    class Repo {
      public constructor(public readonly dep: Dep) {}
    }
    const services = new ServiceManifest<"singleton" | "request">();
    services.add("app/Dep", Dep).as("request");
    services.add(G.RepoTemplate, Repo, [["app/Dep"]]).as("singleton");

    const app = services.build().createScope("singleton");
    const req = app.createScope("request");

    const cachedDep = req.resolve<Dep>("app/Dep");
    const repo = req.resolve<Repo>(G.RepoOfA);

    // The singleton-owned repo constructs relative to the singleton frame,
    // where no "request" frame encloses — its dep is a fresh transient, NOT
    // the request-cached instance (no captured shorter-lived dep).
    expect(repo.dep).toBeInstanceOf(Dep);
    expect(repo.dep).not.toBe(cachedDep);
    expect(req.resolve<Dep>("app/Dep")).toBe(cachedDep);
  });
});

describe("registration-carried signatures", () => {
  test("a closed registration's carried signatures beat the ctor-keyed store", () => {
    class Impl {
      public constructor(public readonly dep: unknown) {}
    }
    defineDeps(Impl, [[T.A]]);

    const services = new ServiceManifest();
    services.addValue(T.A, "A!");
    services.addValue(T.B, "B!");
    services.add("app/S1", Impl, [[T.B]]);
    services.add("app/S2", Impl);

    const sp = services.build();

    expect(sp.resolve<Impl>("app/S1").dep).toBe("B!"); // carried wins
    expect(sp.resolve<Impl>("app/S2").dep).toBe("A!"); // store still serves 2-arg
  });

  test("an open registration's carried template beats the ctor-keyed store", () => {
    class GenImpl {
      public constructor(public readonly dep: unknown) {}
    }
    defineDeps(GenImpl, [[T.A]]);

    const services = new ServiceManifest();
    services.addValue(T.A, "A!");
    services.addValue(T.B, "B!");
    services.add("app/IG<$1>", GenImpl, [["$1"]]);

    const sp = services.build();

    expect(sp.resolve<GenImpl>("app/IG<pkg:IB>").dep).toBe("B!");
  });

  test("an open registration carries its hole template inline (typeArg substitution)", () => {
    class ManualImpl {
      public constructor(
        public readonly dep: unknown,
        public readonly argToken: unknown,
      ) {}
    }

    const services = new ServiceManifest();
    services.addValue(T.A, "A!");
    // Signatures ride on the registration (the global store is retired): the
    // open template's `$1` / typeArg(1) slots substitute per closing.
    services.add("app/IM<$1>", ManualImpl, [["$1", typeArg(1)]]);

    const sp = services.build();
    const m = sp.resolve<ManualImpl>("app/IM<pkg:IA>");

    expect(m.dep).toBe("A!");
    expect(m.argToken).toBe(T.A);
  });
});

describe("errors", () => {
  test("resolving a token that still contains holes throws OpenTokenResolutionError", () => {
    const services = new ServiceManifest();
    services.add(G.RepoTemplate, ZeroRepo);

    const sp = services.build();

    expect(() => sp.resolve(G.RepoTemplate)).toThrow(OpenTokenResolutionError);
    expect(() => sp.resolve("app/Never<$3>")).toThrow(OpenTokenResolutionError);
  });

  test("addValue with an open token throws OpenTokenRegistrationError", () => {
    const services = new ServiceManifest();

    expect(() => services.addValue(G.RepoTemplate, "x")).toThrow(
      OpenTokenRegistrationError,
    );
  });

  test("addFactory with an open token throws OpenTokenRegistrationError", () => {
    const services = new ServiceManifest();

    expect(() => services.addFactory(G.RepoTemplate, () => "x")).toThrow(
      OpenTokenRegistrationError,
    );
  });

  test("mixing concrete args and holes in the service token throws", () => {
    const services = new ServiceManifest();

    expect(() => services.add("app/IR<pkg:IA,$1>", ZeroRepo)).toThrow(
      OpenTokenRegistrationError,
    );
    // Nested holes are not top-level hole nodes either.
    expect(() => services.add("app/IR<app/IBox<$1>>", ZeroRepo)).toThrow(
      OpenTokenRegistrationError,
    );
    // A bare hole has no base at all.
    expect(() => services.add("$1", ZeroRepo)).toThrow(
      OpenTokenRegistrationError,
    );
  });
});

describe("holey slots in normal resolution", () => {
  test("a holey token inside a Union slot is skipped, not thrown", () => {
    class WithUnion {
      public constructor(public readonly dep: unknown) {}
    }
    defineDeps(WithUnion, [[union("app/IX<$1>", T.A)]]);

    const services = new ServiceManifest();
    services.addValue(T.A, "A!");
    services.add(T.Service, WithUnion);

    const sp = services.build();

    expect(sp.resolve<WithUnion>(T.Service).dep).toBe("A!");
  });

  test("a signature containing a holey token is unsatisfiable — greedy selection falls back", () => {
    class Overloaded {
      public constructor(...args: unknown[]) {
        this.args = args;
      }
      public readonly args: unknown[];
    }
    defineDeps(Overloaded, [
      ["app/IX<$1>", T.A],
      [T.A],
    ]);

    const services = new ServiceManifest();
    services.addValue(T.A, "A!");
    services.add(T.Service, Overloaded);

    const sp = services.build();

    expect(sp.resolve<Overloaded>(T.Service).args).toEqual(["A!"]);
  });

  test("a raw TypeArgRef in the only signature is unsatisfiable", () => {
    class RawArg {
      public constructor(public readonly arg: unknown) {}
    }
    defineDeps(RawArg, [[typeArg(1)]]);

    const services = new ServiceManifest();
    services.add(T.Service, RawArg);

    const sp = services.build();

    expect(() => sp.resolve(T.Service)).toThrow(NoSatisfiableSignatureError);
  });
});

describe("gappy open template whose signature references an unbound hole", () => {
  // A mis-authored hand-written open template: the service token binds holes
  // $1 and $3, but a carried signature references $2 — which no closing ever
  // binds (the transformer's 990010 diagnostic prevents this on the plugin
  // path; the manual path has no such guard). Synthesis must NOT crash with a
  // RangeError out of #lookup — it must miss cleanly so resolution raises a
  // DiError and greedy selection can fall back.
  test("resolving such a closing raises a DiError, not an opaque RangeError", () => {
    const services = new ServiceManifest();
    services.add("app/IX<$1,$3>", ZeroRepo, [[typeArg(2)]]);

    const sp = services.build();

    expect(() => sp.resolve("app/IX<pkg:IA,pkg:IB>")).toThrow(
      UnregisteredTokenError,
    );
  });

  test("greedy selection falls back past a signature naming the unbound-hole dep", () => {
    class Host {
      public constructor(...args: unknown[]) {
        this.args = args;
      }
      public readonly args: unknown[];
    }
    // The longer signature depends on a closing of the gappy template; the
    // shorter (empty) signature is a valid fallback.
    defineDeps(Host, [["app/IX<pkg:IA,pkg:IB>"], []]);

    const services = new ServiceManifest();
    services.add("app/IX<$1,$3>", ZeroRepo, [[typeArg(2)]]);
    services.add(T.Service, Host);

    const sp = services.build();

    expect(sp.resolve<Host>(T.Service).args).toEqual([]);
  });
});

describe("disposal of open-synthesized instances (green guard)", () => {
  // The synthesized-from-open ClassRegistration is a distinct object per
  // closing living outside the sealed maps; it caches + registers for disposal
  // exactly like an exact registration. Pin that distinct closings dispose in
  // reverse construction order, both sync and async.
  test("distinct closings dispose in reverse construction order (sync)", () => {
    const log = new DisposeLog();
    const services = new ServiceManifest<"singleton">();
    services
      .add(G.RepoTemplate, SyncDisposable, [[typeArg(1), { value: log }]])
      .as("singleton");

    const app = services.build().createScope("singleton");
    app.resolve(G.RepoOfA); // label pkg:IA, constructed first
    app.resolve(G.RepoOfB); // label pkg:IB, constructed last

    app.dispose();

    expect(log.order).toEqual([T.B, T.A]);
  });

  test("distinct closings dispose in reverse construction order (async)", async () => {
    const log = new DisposeLog();
    const services = new ServiceManifest<"singleton">();
    services
      .add(G.RepoTemplate, AsyncDisposableThing, [[typeArg(1), { value: log }]])
      .as("singleton");

    const app = services.build().createScope("singleton");
    app.resolve(G.RepoOfA);
    app.resolve(G.RepoOfB);

    await app.disposeAsync();

    expect(log.order).toEqual([T.B, T.A]);
  });
});

describe("resolveFactory against an open template — top-level public API (green guard)", () => {
  // sp.resolveFactory(closedToken, params) funnels through the SAME open
  // fallback in #lookup as a FactoryRef ctor slot, but from a distinct call
  // site. Pin that the registration-carried substituted signature wins over the
  // ctor-keyed defineDeps store on this path too.
  test("zero-arg strict mode resolves a closing; carried template beats the ctor store", () => {
    class GenSvc {
      public constructor(public readonly dep: unknown) {}
    }
    defineDeps(GenSvc, [[T.A]]); // ctor-keyed store — must lose to the carried template

    const services = new ServiceManifest();
    services.addValue(T.A, "A!");
    services.addValue(T.B, "B!");
    services.add("app/IG<$1>", GenSvc, [["$1"]]);

    const sp = services.build();
    const make = sp.resolveFactory(closeToken("app/IG" as Token, T.B)) as () => GenSvc;
    const svc = make();

    expect(svc).toBeInstanceOf(GenSvc);
    expect(svc.dep).toBe("B!"); // "$1" → pkg:IB wins over the store's pkg:IA
  });

  test("parameterized mode partitions caller args against the substituted signature", () => {
    class Widget {
      public constructor(
        public readonly seed: unknown,
        public readonly supplied: unknown,
      ) {}
    }
    defineDeps(Widget, [["app/WRONG", "app/WRONG2"]]); // ctor store must not win

    const services = new ServiceManifest();
    services.addValue(T.A, "A!");
    services.add("app/IW<$1>", Widget, [["$1", "app/IParam"]]);

    const sp = services.build();
    const make = sp.resolveFactory("app/IW<pkg:IA>", ["app/IParam"]) as (
      p: unknown,
    ) => Widget;
    const w = make("supplied!");

    expect(w).toBeInstanceOf(Widget);
    expect(w.seed).toBe("A!"); // "$1" → pkg:IA resolved from the container
    expect(w.supplied).toBe("supplied!"); // caller-supplied param
  });
});

describe("build() twice with open registrations (green guard)", () => {
  test("each build() yields an independent provider — no synthesized-closing leak", () => {
    const services = new ServiceManifest<"singleton">();
    services.add(G.RepoTemplate, ZeroRepo).as("singleton");

    const p1 = services.build().createScope("singleton");
    const p2 = services.build().createScope("singleton");

    const a1 = p1.resolve(G.RepoOfA);
    const a2 = p2.resolve(G.RepoOfA);

    // Each build() allocates its OWN empty #closedMemo + sealed-open copy, so
    // the same closing synthesizes a DISTINCT Registration (and singleton)
    // per provider tree; neither leaks into the other.
    expect(a1).not.toBe(a2);
    expect(p1.resolve(G.RepoOfA)).toBe(a1);
    expect(p2.resolve(G.RepoOfA)).toBe(a2);
  });
});
