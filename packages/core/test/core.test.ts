import { test, expect, describe } from "bun:test";
import { hole, defineDeps, getDeps, signature, forCtor } from "@fnioc/core";
import type { AnyOf, FactoryRef, DepSlot } from "@fnioc/core";

// ── Constants ─────────────────────────────────────────────────────────────────

describe("hole", () => {
  test("is the null sentinel at runtime", () => {
    expect(hole).toBeNull();
  });

  test("is accepted where a DepSlot is expected", () => {
    // Type-level: if this compiles, the type is correct.
    // (This test file would fail to compile if `hole` weren't a valid DepSlot.)
    defineDeps(class HoleTypeCheck {}, [[hole]]);
    const rec = getDeps(class HoleTypeCheck {});
    // We're not asserting about this class; the meaningful assertion is that
    // the defineDeps call above compiles without a type error.
    expect(rec).toBeUndefined(); // different anonymous class; just verifying we get here
  });
});

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

  test("preserves a hole sentinel inside a stored signature", () => {
    class HoleCtor {}

    defineDeps(HoleCtor, [["token:ILogger", hole, "token:IDb"]]);

    const rec = getDeps(HoleCtor);
    expect(rec!.signatures[0]).toEqual(["token:ILogger", hole, "token:IDb"]);
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

// ── @signature decorator ──────────────────────────────────────────────────────

describe("signature decorator", () => {
  test("single decorator writes one signature readable via getDeps", () => {
    @signature("dec:IFoo", "dec:IBar")
    class SingleDecorated {}

    const rec = getDeps(SingleDecorated);
    expect(rec).toBeDefined();
    expect(rec!.signatures).toHaveLength(1);
    expect(rec!.signatures[0]).toEqual(["dec:IFoo", "dec:IBar"]);
  });

  test("stacked decorators register two signatures (both present)", () => {
    // TC39 decorators evaluate bottom-up, so @signature("dec:IDb") runs first,
    // then @signature("dec:ILogger", "dec:IDb"). Both should be present.
    @signature("dec:ILogger", "dec:IDb")
    @signature("dec:IDb")
    class StackedDecorated {}

    const rec = getDeps(StackedDecorated);
    expect(rec).toBeDefined();
    expect(rec!.signatures).toHaveLength(2);

    const sigs = rec!.signatures.map((s) => [...s]);
    expect(sigs).toContainEqual(["dec:IDb"]);
    expect(sigs).toContainEqual(["dec:ILogger", "dec:IDb"]);
  });

  test("hole is accepted in a decorator signature", () => {
    @signature("dec:ILogger", hole, "dec:IDb")
    class DecoratedWithHole {}

    const rec = getDeps(DecoratedWithHole);
    expect(rec!.signatures[0]).toEqual(["dec:ILogger", hole, "dec:IDb"]);
  });

  test("decorator does not replace the class (returns void)", () => {
    @signature("dec:IFoo")
    class NotReplaced {
      readonly tag = "original";
    }

    // The class constructor itself must still be the original one.
    const instance = new NotReplaced();
    expect(instance.tag).toBe("original");
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

  test("hole is accepted in a forCtor signature", () => {
    class ForCtorWithHole {}

    forCtor(ForCtorWithHole).signature("fc:ILogger", hole, "fc:IDb");

    const rec = getDeps(ForCtorWithHole);
    expect(rec!.signatures[0]).toEqual(["fc:ILogger", hole, "fc:IDb"]);
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
    const ref: FactoryRef = { factory: "exp:IFoo" };
    const slots: readonly DepSlot[] = ["exp:IBar", hole, ref];
    expect(ref.factory).toBe("exp:IFoo");
    expect(slots).toHaveLength(3);
  });

  test("a FactoryRef slot is stored verbatim in the DepRecord", () => {
    class FactorySlotCtor {}

    defineDeps(FactorySlotCtor, [["slot:ILogger", { factory: "slot:IFoo" }]]);

    const rec = getDeps(FactorySlotCtor);
    expect(rec!.signatures[0]).toEqual([
      "slot:ILogger",
      { factory: "slot:IFoo" },
    ]);
  });

  describe("structural dedup", () => {
    test("two identical { factory } slots dedup to one signature", () => {
      class FactoryDedupSame {}

      defineDeps(FactoryDedupSame, [["dedup:IA", { factory: "dedup:IX" }]]);
      defineDeps(FactoryDedupSame, [["dedup:IA", { factory: "dedup:IX" }]]);

      const rec = getDeps(FactoryDedupSame);
      expect(rec!.signatures).toHaveLength(1);
    });

    test("{factory:'x'} vs {factory:'y'} stay distinct signatures", () => {
      class FactoryDedupDiff {}

      defineDeps(FactoryDedupDiff, [["dedup:IA", { factory: "dedup:IX" }]]);
      defineDeps(FactoryDedupDiff, [["dedup:IA", { factory: "dedup:IY" }]]);

      const rec = getDeps(FactoryDedupDiff);
      expect(rec!.signatures).toHaveLength(2);
    });

    test("a string slot and a FactoryRef slot stay distinct", () => {
      class FactoryVsStringCtor {}

      // Same arity, same first slot; differ only in the second slot's KIND
      // (string token vs FactoryRef). Must NOT dedup.
      defineDeps(FactoryVsStringCtor, [["kind:IA", "kind:IFoo"]]);
      defineDeps(FactoryVsStringCtor, [["kind:IA", { factory: "kind:IFoo" }]]);

      const rec = getDeps(FactoryVsStringCtor);
      expect(rec!.signatures).toHaveLength(2);
    });
  });

  test("authoring a factory slot via @signature writes the expected record", () => {
    @signature("dec:ILogger", { factory: "dec:IFoo" })
    class DecoratedFactory {}

    const rec = getDeps(DecoratedFactory);
    expect(rec!.signatures).toHaveLength(1);
    expect(rec!.signatures[0]).toEqual([
      "dec:ILogger",
      { factory: "dec:IFoo" },
    ]);
  });

  test("authoring a factory slot via forCtor writes the expected record", () => {
    class ForCtorFactory {}

    forCtor(ForCtorFactory).signature("fc:ILogger", { factory: "fc:IFoo" });

    const rec = getDeps(ForCtorFactory);
    expect(rec!.signatures).toHaveLength(1);
    expect(rec!.signatures[0]).toEqual(["fc:ILogger", { factory: "fc:IFoo" }]);
  });
});

// ── AnyOf dep slot ──────────────────────────────────────────────────────────

describe("AnyOf dep slot", () => {
  test("AnyOf is accepted where a DepSlot is expected (type-level + runtime)", () => {
    // Type-level: if this compiles, AnyOf is a valid DepSlot.
    const anyOf: AnyOf = { anyOf: ["pkg:IA", "pkg:IB"] };
    const slots: readonly DepSlot[] = [anyOf];
    expect(slots).toHaveLength(1);
    expect((slots[0] as AnyOf).anyOf).toEqual(["pkg:IA", "pkg:IB"]);
  });

  test("defineDeps accepts AnyOf inside a signature and round-trips through getDeps", () => {
    class AnyOfCtor {}

    defineDeps(AnyOfCtor, [[{ anyOf: ["pkg:IA", "pkg:IB"] }]]);

    const rec = getDeps(AnyOfCtor);
    expect(rec).toBeDefined();
    expect(rec!.signatures).toHaveLength(1);
    expect(rec!.signatures[0]).toEqual([{ anyOf: ["pkg:IA", "pkg:IB"] }]);
  });

  test("AnyOf round-trips via @signature decorator", () => {
    @signature({ anyOf: ["dec:IA", "dec:IB"] })
    class AnyOfDecorated {}

    const rec = getDeps(AnyOfDecorated);
    expect(rec!.signatures[0]).toEqual([{ anyOf: ["dec:IA", "dec:IB"] }]);
  });

  test("discriminant safety: AnyOf is distinct from FactoryRef and ScopeRef and hole", () => {
    const anyOf: DepSlot = { anyOf: ["tok:IA", "tok:IB"] };
    const factoryRef: DepSlot = { factory: "tok:IX" };
    const scopeRef: DepSlot = { scope: true };
    const holeSlot: DepSlot = hole;

    // AnyOf discriminant: `anyOf` property is an Array
    expect(
      anyOf !== null &&
        typeof anyOf === "object" &&
        Array.isArray((anyOf as { anyOf?: unknown }).anyOf),
    ).toBe(true);

    // FactoryRef is NOT an AnyOf
    expect(
      factoryRef !== null &&
        typeof factoryRef === "object" &&
        Array.isArray((factoryRef as { anyOf?: unknown }).anyOf),
    ).toBe(false);

    // ScopeRef is NOT an AnyOf
    expect(
      scopeRef !== null &&
        typeof scopeRef === "object" &&
        Array.isArray((scopeRef as { anyOf?: unknown }).anyOf),
    ).toBe(false);

    // hole (null) is NOT an AnyOf
    expect(
      holeSlot !== null &&
        typeof holeSlot === "object" &&
        Array.isArray((holeSlot as unknown as { anyOf?: unknown }).anyOf),
    ).toBe(false);
  });

  test("AnyOf containing FactoryRef and ScopeRef members round-trips verbatim", () => {
    class AnyOfComplexCtor {}

    defineDeps(AnyOfComplexCtor, [
      [{ anyOf: [{ factory: "tok:IFoo" }, "tok:IBar", { scope: true }] }],
    ]);

    const rec = getDeps(AnyOfComplexCtor);
    expect(rec!.signatures[0]).toEqual([
      { anyOf: [{ factory: "tok:IFoo" }, "tok:IBar", { scope: true }] },
    ]);
  });
});
