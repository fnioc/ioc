import { test, expect, describe } from "bun:test";
import {
  defineDeps,
  getDeps,
  forCtor,
  union,
  typeArg,
  isFactoryRef,
  isScopeRef,
  isUnionSlot,
  isLiteralRef,
  isTypeArgRef,
} from "@fnioc/core";
import type {
  FactoryRef,
  DepSlot,
  Union,
  Inject,
  Token,
  Hole,
  $,
  Typeof,
} from "@fnioc/core";

// ── Global anchor ─────────────────────────────────────────────────────────────

describe("global-symbol Map anchor", () => {
  const GLOBAL_KEY = Symbol.for("fnioc:deps");

  test("store is anchored on globalThis under the global-symbol key", () => {
    const raw = (globalThis as Record<symbol, unknown>)[GLOBAL_KEY];
    expect(raw).toBeDefined();
    expect(raw instanceof Map).toBe(true);
  });

  test("defineDeps writes through the same Map visible on globalThis", () => {
    class GlobalAnchorProbe {}

    defineDeps(GlobalAnchorProbe, [["anchor:IFoo"]]);

    // Read the record back directly via globalThis to prove the package is NOT
    // using a module-private map — this is the dual-package hardening proof.
    const rawStore = (globalThis as Record<symbol, unknown>)[
      GLOBAL_KEY
    ] as Map<object, unknown>;
    expect(rawStore.get(GlobalAnchorProbe)).toBeDefined();
    expect(rawStore.get(GlobalAnchorProbe)).toBe(getDeps(GlobalAnchorProbe));
  });
});

// ── Two-copies-share-one-Map (PRD §5) ────────────────────────────────────────
//
// A second independent copy of @fnioc/core recomputes `Symbol.for("fnioc:deps")`
// and lands on the SAME entry in the global symbol registry — and therefore the
// SAME Map. This describe block simulates "copy B" by accessing globalThis
// via the independently-recomputed key, without going through the module's
// exported `store` binding.

describe("two-copies-share-one-Map (PRD §5)", () => {
  // "Copy B" independently derives the same key — this is the whole point of
  // Symbol.for: any code that knows the string gets the same symbol.
  const COPY_B_KEY = Symbol.for("fnioc:deps");
  type RawStore = Map<object, { signatures: unknown[][] }>;

  test("copy-A write (defineDeps) is visible via copy-B direct-global read", () => {
    // copy A: write through the public API
    class CopyAWriteCtor {}
    defineDeps(CopyAWriteCtor, [["share:IFoo"]]);

    // copy B: read by reaching into globalThis with an independently-derived key
    const copyBStore = (globalThis as Record<symbol, unknown>)[
      COPY_B_KEY
    ] as RawStore;
    const viaGlobal = copyBStore.get(CopyAWriteCtor);

    // Must be the SAME object reference (not a clone) — same Map
    expect(viaGlobal).toBe(getDeps(CopyAWriteCtor));
    expect(viaGlobal).toBeDefined();
  });

  test("copy-B write (direct-global put) is visible via copy-A public read (getDeps)", () => {
    // copy B: write directly into the shared Map, bypassing the module's API
    class CopyBWriteCtor {}
    const copyBStore = (globalThis as Record<symbol, unknown>)[
      COPY_B_KEY
    ] as RawStore;
    const fakeRecord = { signatures: [["share:IBar"]] };
    copyBStore.set(CopyBWriteCtor, fakeRecord);

    // copy A: read through the public API — must see what copy B wrote
    const viaApi = getDeps(CopyBWriteCtor);
    expect(viaApi).toBe(fakeRecord);
  });
});

// ── defineDeps ────────────────────────────────────────────────────────────────

describe("defineDeps", () => {
  test("creates a DepRecord when none exists", () => {
    class FreshCtor {}

    defineDeps(FreshCtor, [["token:IFoo"]]);

    const rec = getDeps(FreshCtor);
    expect(rec).toBeDefined();
    expect(rec!.signatures).toHaveLength(1);
    expect(rec!.signatures[0]).toEqual(["token:IFoo"]);
  });

  test("appends a distinct signature to an existing record", () => {
    class MultiSigCtor {}

    defineDeps(MultiSigCtor, [["token:IA"]]);
    defineDeps(MultiSigCtor, [["token:IA", "token:IB"]]);

    const rec = getDeps(MultiSigCtor);
    expect(rec!.signatures).toHaveLength(2);
    // Both signatures are present; order is append-order (bottom-up decorator semantics
    // make the actual order decorator-runtime-dependent, so we assert containment only).
    const sigs = rec!.signatures.map((s) => [...s]);
    expect(sigs).toContainEqual(["token:IA"]);
    expect(sigs).toContainEqual(["token:IA", "token:IB"]);
  });

  test("dedupes an identical signature — does not add a duplicate", () => {
    class DedupeCtor {}

    defineDeps(DedupeCtor, [["token:IX"]]);
    defineDeps(DedupeCtor, [["token:IX"]]); // exact duplicate

    const rec = getDeps(DedupeCtor);
    expect(rec!.signatures).toHaveLength(1);
    expect(rec!.signatures[0]).toEqual(["token:IX"]);
  });

  test("an unregistered token is accepted where a DepSlot is expected", () => {
    class UnregCtor {}

    // An unregistered token is just a plain string — caller-supplied at resolve time.
    defineDeps(UnregCtor, [["token:ILogger", "caller:supplied", "token:IDb"]]);

    const rec = getDeps(UnregCtor);
    expect(rec!.signatures[0]).toEqual(["token:ILogger", "caller:supplied", "token:IDb"]);
  });

  test("keys by exact constructor — subclass does NOT inherit parent's record", () => {
    class Parent {}
    class Child extends Parent {}

    defineDeps(Parent, [["token:IParent"]]);

    // getDeps(Child) must return undefined; the Map is keyed by the exact
    // constructor, not the prototype chain.
    expect(getDeps(Child)).toBeUndefined();
  });

  test("records from different ctors are independent", () => {
    class CtorA {}
    class CtorB {}

    defineDeps(CtorA, [["token:A1"]]);
    defineDeps(CtorB, [["token:B1", "token:B2"]]);

    expect(getDeps(CtorA)!.signatures).toHaveLength(1);
    expect(getDeps(CtorB)!.signatures).toHaveLength(1);
  });
});

// ── getDeps ───────────────────────────────────────────────────────────────────

describe("getDeps", () => {
  test("returns the stored DepRecord for a registered ctor", () => {
    class KnownCtor {}
    defineDeps(KnownCtor, [["token:IKnown"]]);

    const rec = getDeps(KnownCtor);
    expect(rec).toBeDefined();
    expect(rec!.signatures[0]).toEqual(["token:IKnown"]);
  });

  test("returns undefined for an unregistered ctor", () => {
    class UnknownCtor {}
    expect(getDeps(UnknownCtor)).toBeUndefined();
  });
});

// ── forCtor ───────────────────────────────────────────────────────────────────

describe("forCtor", () => {
  test("single .signature() call writes one signature", () => {
    class ForCtorSingle {}

    forCtor(ForCtorSingle).signature("fc:IFoo");

    const rec = getDeps(ForCtorSingle);
    expect(rec).toBeDefined();
    expect(rec!.signatures).toHaveLength(1);
    expect(rec!.signatures[0]).toEqual(["fc:IFoo"]);
  });

  test("chained .signature() calls write two signatures (both present)", () => {
    class ForCtorChained {}

    forCtor(ForCtorChained)
      .signature("fc:IDb")
      .signature("fc:ILogger", "fc:IDb");

    const rec = getDeps(ForCtorChained);
    expect(rec).toBeDefined();
    expect(rec!.signatures).toHaveLength(2);

    const sigs = rec!.signatures.map((s) => [...s]);
    expect(sigs).toContainEqual(["fc:IDb"]);
    expect(sigs).toContainEqual(["fc:ILogger", "fc:IDb"]);
  });

  test("builder is the same object (for chaining identity)", () => {
    class ForCtorChainId {}

    const builder = forCtor(ForCtorChainId);
    const returned = builder.signature("fc:IFoo");
    expect(returned).toBe(builder);
  });
});

// ── FactoryRef slot ─────────────────────────────────────────────────────────

describe("FactoryRef dep slot", () => {
  test("FactoryRef and DepSlot are exported (type-level)", () => {
    // If these annotations compile, the types are exported. The runtime values
    // are only here so the references aren't elided.
    const ref: FactoryRef = { type: "exp:IFoo" };
    const slots: readonly DepSlot[] = ["exp:IBar", ref];
    expect(ref.type).toBe("exp:IFoo");
    expect(slots).toHaveLength(2);
  });

  test("FactoryRef with params field", () => {
    const ref: FactoryRef = { type: "exp:IFoo", params: ["exp:ParamA", "exp:ParamB"] };
    expect(ref.type).toBe("exp:IFoo");
    expect(ref.params).toEqual(["exp:ParamA", "exp:ParamB"]);
  });

  test("a FactoryRef slot is stored verbatim in the DepRecord", () => {
    class FactorySlotCtor {}

    defineDeps(FactorySlotCtor, [["slot:ILogger", { type: "slot:IFoo" }]]);

    const rec = getDeps(FactorySlotCtor);
    expect(rec!.signatures[0]).toEqual([
      "slot:ILogger",
      { type: "slot:IFoo" },
    ]);
  });

  describe("structural dedup", () => {
    test("two identical { type } slots dedup to one signature", () => {
      class FactoryDedupSame {}

      defineDeps(FactoryDedupSame, [["dedup:IA", { type: "dedup:IX" }]]);
      defineDeps(FactoryDedupSame, [["dedup:IA", { type: "dedup:IX" }]]);

      const rec = getDeps(FactoryDedupSame);
      expect(rec!.signatures).toHaveLength(1);
    });

    test("{type:'x'} vs {type:'y'} stay distinct signatures", () => {
      class FactoryDedupDiff {}

      defineDeps(FactoryDedupDiff, [["dedup:IA", { type: "dedup:IX" }]]);
      defineDeps(FactoryDedupDiff, [["dedup:IA", { type: "dedup:IY" }]]);

      const rec = getDeps(FactoryDedupDiff);
      expect(rec!.signatures).toHaveLength(2);
    });

    test("two FactoryRefs with same type but different params are distinct", () => {
      class FactoryParamsDiff {}

      defineDeps(FactoryParamsDiff, [["dedup:IA", { type: "dedup:IX", params: ["a"] }]]);
      defineDeps(FactoryParamsDiff, [["dedup:IA", { type: "dedup:IX", params: ["b"] }]]);

      const rec = getDeps(FactoryParamsDiff);
      expect(rec!.signatures).toHaveLength(2);
    });

    test("two FactoryRefs with same type and same params dedup", () => {
      class FactoryParamsSame {}

      defineDeps(FactoryParamsSame, [["dedup:IA", { type: "dedup:IX", params: ["a", "b"] }]]);
      defineDeps(FactoryParamsSame, [["dedup:IA", { type: "dedup:IX", params: ["a", "b"] }]]);

      const rec = getDeps(FactoryParamsSame);
      expect(rec!.signatures).toHaveLength(1);
    });

    test("a string slot and a FactoryRef slot stay distinct", () => {
      class FactoryVsStringCtor {}

      // Same arity, same first slot; differ only in the second slot's KIND
      // (string token vs FactoryRef). Must NOT dedup.
      defineDeps(FactoryVsStringCtor, [["kind:IA", "kind:IFoo"]]);
      defineDeps(FactoryVsStringCtor, [["kind:IA", { type: "kind:IFoo" }]]);

      const rec = getDeps(FactoryVsStringCtor);
      expect(rec!.signatures).toHaveLength(2);
    });
  });

  test("authoring a factory slot via forCtor writes the expected record", () => {
    class ForCtorFactory {}

    forCtor(ForCtorFactory).signature("fc:ILogger", { type: "fc:IFoo" });

    const rec = getDeps(ForCtorFactory);
    expect(rec!.signatures).toHaveLength(1);
    expect(rec!.signatures[0]).toEqual(["fc:ILogger", { type: "fc:IFoo" }]);
  });
});

// ── isFactoryRef / isScopeRef / isUnionSlot guards ───────────────────────────

describe("type guards", () => {
  test("isFactoryRef: true for { type: string }", () => {
    const slot: DepSlot = { type: "tok:IFoo" };
    expect(isFactoryRef(slot)).toBe(true);
  });

  test("isFactoryRef: false for a string token", () => {
    expect(isFactoryRef("tok:IFoo")).toBe(false);
  });

  test("isFactoryRef: false for { scope: true }", () => {
    const slot: DepSlot = { scope: true };
    expect(isFactoryRef(slot)).toBe(false);
  });

  test("isFactoryRef: false for a Union slot", () => {
    const slot: DepSlot = { union: ["tok:A"] };
    expect(isFactoryRef(slot)).toBe(false);
  });

  test("isScopeRef: true for { scope: true }", () => {
    const slot: DepSlot = { scope: true };
    expect(isScopeRef(slot)).toBe(true);
  });

  test("isScopeRef: false for a string token", () => {
    expect(isScopeRef("tok:IFoo")).toBe(false);
  });

  test("isUnionSlot: true for { union: [...] }", () => {
    const slot: DepSlot = { union: ["tok:A", "tok:B"] };
    expect(isUnionSlot(slot)).toBe(true);
  });

  test("isUnionSlot: false for a string token", () => {
    expect(isUnionSlot("tok:A")).toBe(false);
  });

  test("isUnionSlot: false for a FactoryRef", () => {
    const slot: DepSlot = { type: "tok:IFoo" };
    expect(isUnionSlot(slot)).toBe(false);
  });
});

// ── Union slot and union() helper ─────────────────────────────────────────────

describe("Union slot", () => {
  test("union() smoke: union('a','b') → { union: ['a','b'] }", () => {
    const u = union("a", "b");
    expect(u).toEqual({ union: ["a", "b"] });
  });

  test("union() with no args produces an empty union", () => {
    const u = union();
    expect(u).toEqual({ union: [] });
  });

  test("union() accepts FactoryRef members", () => {
    const ref: FactoryRef = { type: "tok:IFoo" };
    const u = union("tok:A", ref);
    expect(u).toEqual({ union: ["tok:A", { type: "tok:IFoo" }] });
  });

  test("union() accepts nested unions", () => {
    const inner = union("tok:A", "tok:B");
    const outer = union(inner, "tok:C");
    expect(outer).toEqual({ union: [{ union: ["tok:A", "tok:B"] }, "tok:C"] });
  });

  test("a Union slot is stored verbatim in the DepRecord", () => {
    class UnionSlotCtor {}

    defineDeps(UnionSlotCtor, [["tok:ILogger", union("tok:IRedis", "tok:IMemory")]]);

    const rec = getDeps(UnionSlotCtor);
    expect(rec!.signatures[0]).toEqual([
      "tok:ILogger",
      { union: ["tok:IRedis", "tok:IMemory"] },
    ]);
  });

  describe("Union structural dedup in slotsEqual", () => {
    test("two identical Union slots dedup to one signature", () => {
      class UnionDedupSame {}

      defineDeps(UnionDedupSame, [["tok:IA", union("tok:IX", "tok:IY")]]);
      defineDeps(UnionDedupSame, [["tok:IA", union("tok:IX", "tok:IY")]]);

      const rec = getDeps(UnionDedupSame);
      expect(rec!.signatures).toHaveLength(1);
    });

    test("unions with different members stay distinct", () => {
      class UnionDedupDiff {}

      defineDeps(UnionDedupDiff, [["tok:IA", union("tok:IX", "tok:IY")]]);
      defineDeps(UnionDedupDiff, [["tok:IA", union("tok:IX", "tok:IZ")]]);

      const rec = getDeps(UnionDedupDiff);
      expect(rec!.signatures).toHaveLength(2);
    });

    test("unions with different lengths stay distinct", () => {
      class UnionLenDiff {}

      defineDeps(UnionLenDiff, [["tok:IA", union("tok:IX")]]);
      defineDeps(UnionLenDiff, [["tok:IA", union("tok:IX", "tok:IY")]]);

      const rec = getDeps(UnionLenDiff);
      expect(rec!.signatures).toHaveLength(2);
    });

    test("a Union slot and a string slot with the same token stay distinct", () => {
      class UnionVsString {}

      defineDeps(UnionVsString, [["tok:IA", "tok:IX"]]);
      defineDeps(UnionVsString, [["tok:IA", union("tok:IX")]]);

      const rec = getDeps(UnionVsString);
      expect(rec!.signatures).toHaveLength(2);
    });

    test("nested unions are compared recursively", () => {
      class NestedUnionDedup {}

      const sig1: DepSlot = union(union("tok:A", "tok:B"), "tok:C");
      const sig2: DepSlot = union(union("tok:A", "tok:B"), "tok:C");
      const sig3: DepSlot = union(union("tok:A", "tok:X"), "tok:C");

      defineDeps(NestedUnionDedup, [["tok:X", sig1]]);
      defineDeps(NestedUnionDedup, [["tok:X", sig2]]); // should dedup
      defineDeps(NestedUnionDedup, [["tok:X", sig3]]); // distinct

      const rec = getDeps(NestedUnionDedup);
      expect(rec!.signatures).toHaveLength(2);
    });
  });
});

// ── Inject brand (type-level) ─────────────────────────────────────────────────

describe("Inject brand", () => {
  test("Inject<T, K> is assignable from plain T (optional brand property)", () => {
    // A plain string is assignable to Inject<string, "my:tok"> because [TOK]? is optional.
    // This is a compile-time test — if these type annotations compile, the brand is correct.
    const plain: string = "hello";
    const branded: Inject<string, "my:tok"> = plain;
    expect(branded).toBe("hello");
  });

  test("Inject type is exported and usable in a DepSlot context indirectly", () => {
    // Inject<T, K> widens to T, so it cannot appear directly as a DepSlot.
    // This test verifies the type is exported and the pattern compiles.
    // The transformer reads the brand from the type system, not at runtime.
    type _Check = Inject<{ id: number }, "pkg:MyService">;
    const val: Inject<{ id: number }, "pkg:MyService"> = { id: 1 };
    expect(val.id).toBe(1);
  });
});

// ── typeArg() helper and TypeArgRef slot ─────────────────────────────────────

describe("typeArg helper", () => {
  test("typeArg(n) constructs { typeArg: n }", () => {
    expect(typeArg(1)).toEqual({ typeArg: 1 });
    expect(typeArg(3)).toEqual({ typeArg: 3 });
  });

  test("a TypeArgRef slot is stored verbatim in the DepRecord", () => {
    class TypeArgSlotCtor {}

    defineDeps(TypeArgSlotCtor, [[typeArg(1), "slot:IDb"]]);

    const rec = getDeps(TypeArgSlotCtor);
    expect(rec!.signatures[0]).toEqual([{ typeArg: 1 }, "slot:IDb"]);
  });
});

describe("isTypeArgRef guard", () => {
  test("true for { typeArg: number }", () => {
    expect(isTypeArgRef(typeArg(1))).toBe(true);
    expect(isTypeArgRef({ typeArg: 9 })).toBe(true);
  });

  test("false for every other slot kind", () => {
    expect(isTypeArgRef("tok:IFoo")).toBe(false);
    expect(isTypeArgRef({ type: "tok:IFoo" })).toBe(false);
    expect(isTypeArgRef({ scope: true })).toBe(false);
    expect(isTypeArgRef({ union: ["tok:A"] })).toBe(false);
    expect(isTypeArgRef({ value: 1 })).toBe(false);
  });

  test("other guards are false for a TypeArgRef (key-disjoint)", () => {
    const slot: DepSlot = typeArg(2);
    expect(isFactoryRef(slot)).toBe(false);
    expect(isScopeRef(slot)).toBe(false);
    expect(isUnionSlot(slot)).toBe(false);
    expect(isLiteralRef(slot)).toBe(false);
  });
});

describe("TypeArgRef structural dedup in slotsEqual", () => {
  test("two identical TypeArgRef slots dedup to one signature", () => {
    class TypeArgDedupSame {}

    defineDeps(TypeArgDedupSame, [["tok:IA", typeArg(1)]]);
    defineDeps(TypeArgDedupSame, [["tok:IA", typeArg(1)]]);

    const rec = getDeps(TypeArgDedupSame);
    expect(rec!.signatures).toHaveLength(1);
  });

  test("different hole numbers stay distinct signatures", () => {
    class TypeArgDedupDiff {}

    defineDeps(TypeArgDedupDiff, [["tok:IA", typeArg(1)]]);
    defineDeps(TypeArgDedupDiff, [["tok:IA", typeArg(2)]]);

    const rec = getDeps(TypeArgDedupDiff);
    expect(rec!.signatures).toHaveLength(2);
  });

  test("a TypeArgRef and a LiteralRef with matching numbers stay distinct", () => {
    class TypeArgVsLiteral {}

    defineDeps(TypeArgVsLiteral, [["tok:IA", typeArg(1)]]);
    defineDeps(TypeArgVsLiteral, [["tok:IA", { value: 1 }]]);

    const rec = getDeps(TypeArgVsLiteral);
    expect(rec!.signatures).toHaveLength(2);
  });

  test("a TypeArgRef and a string slot stay distinct", () => {
    class TypeArgVsString {}

    defineDeps(TypeArgVsString, [["tok:IA", typeArg(1)]]);
    defineDeps(TypeArgVsString, [["tok:IA", "$1"]]);

    const rec = getDeps(TypeArgVsString);
    expect(rec!.signatures).toHaveLength(2);
  });
});

// ── Hole / $<N> / Typeof brands (type-level) ─────────────────────────────

describe("Hole brand", () => {
  test("$<N> aliases are usable as type arguments (the authoring position)", () => {
    // Holes appear as TYPE ARGUMENTS (`SqlRepository<$<1>>`), never as value
    // targets — an unconstrained hole is a weak brand type, so a VALUE slot
    // typed by one takes an explicit cast. That's fine: the transformer reads
    // holes from the type system; no runtime value ever inhabits one.
    class Box<T> {
      constructor(readonly value: T) {}
    }
    const first = new Box<$<1>>("payload" as $<1>);
    const second = new Box<$<2>>(42 as $<2>);
    expect(first.value).toBe("payload" as $<1>);
    expect(second.value).toBe(42 as $<2>);
  });

  test("constrained skolem: Hole<1, Entity> is assignable TO Entity", () => {
    // The brand property is optional, so the intersection stays an Entity —
    // this is what lets `class Repo<T extends Entity>` accept a hole.
    interface Entity {
      readonly id: number;
    }
    const skolem: Hole<1, Entity> = { id: 7 };
    const asEntity: Entity = skolem;
    expect(asEntity.id).toBe(7);
  });

  test("constrained skolem satisfies a T-extends-constraint type parameter", () => {
    interface Entity {
      readonly id: number;
    }
    class Repo<T extends Entity> {
      keep(entity: T): T {
        return entity;
      }
    }
    // If this instantiation compiles, Hole<1, Entity> satisfies `T extends Entity`.
    const repo = new Repo<Hole<1, Entity>>();
    expect(repo.keep({ id: 1 }).id).toBe(1);
  });
});

describe("Typeof brand", () => {
  test("Typeof<T> is assignable from a plain string (branded Token)", () => {
    interface Entity {
      readonly id: number;
    }
    const token: Typeof<Entity> = "./src/Entity";
    const asToken: Token = token;
    expect(asToken).toBe("./src/Entity");
  });

  test("Typeof works with a Hole binding (open-template authoring shape)", () => {
    class Witness<T> {
      constructor(readonly entityToken: Typeof<T>) {}
    }
    const w = new Witness<$<1>>("app/IUser");
    expect(w.entityToken).toBe("app/IUser");
  });
});
