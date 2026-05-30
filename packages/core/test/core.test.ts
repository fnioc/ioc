import { test, expect, describe } from "bun:test";
import {
  ABI_VERSION,
  hole,
  defineDeps,
  getDeps,
  signature,
  forCtor,
} from "@fnioc/core";

// ── Constants ─────────────────────────────────────────────────────────────────

describe("ABI_VERSION", () => {
  test("is 1", () => {
    expect(ABI_VERSION).toBe(1);
  });
});

describe("hole", () => {
  test("is null at runtime", () => {
    expect(hole).toBeNull();
  });

  test("is accepted where Token | null is expected", () => {
    // Type-level: if this compiles, the type is correct.
    // (This test file would fail to compile if `hole` weren't assignable to
    //  `Token | null`.)
    defineDeps(class HoleTypeCheck {}, [[hole]]);
    const rec = getDeps(class HoleTypeCheck {});
    // We're not asserting about this class; the meaningful assertion is that
    // the defineDeps call above compiles without a type error.
    expect(rec).toBeUndefined(); // different anonymous class; just verifying we get here
  });
});

// ── Global anchor ─────────────────────────────────────────────────────────────

describe("global-symbol WeakMap anchor", () => {
  const GLOBAL_KEY = Symbol.for(`@fnioc/core:deps@${ABI_VERSION}`);

  test("store is anchored on globalThis under the version-suffixed key", () => {
    const raw = (globalThis as Record<symbol, unknown>)[GLOBAL_KEY];
    expect(raw).toBeDefined();
    expect(raw instanceof WeakMap).toBe(true);
  });

  test("defineDeps writes through the same WeakMap visible on globalThis", () => {
    class GlobalAnchorProbe {}

    defineDeps(GlobalAnchorProbe, [["anchor:IFoo"]]);

    // Read the record back directly via globalThis to prove the package is NOT
    // using a module-private map — this is the dual-package hardening proof.
    const rawStore = (globalThis as Record<symbol, unknown>)[
      GLOBAL_KEY
    ] as WeakMap<Function, unknown>;
    expect(rawStore.get(GlobalAnchorProbe)).toBeDefined();
    expect((rawStore.get(GlobalAnchorProbe) as { abi: number }).abi).toBe(
      ABI_VERSION,
    );
  });
});

// ── defineDeps ────────────────────────────────────────────────────────────────

describe("defineDeps", () => {
  test("creates a DepRecord when none exists", () => {
    class FreshCtor {}

    defineDeps(FreshCtor, [["token:IFoo"]]);

    const rec = getDeps(FreshCtor);
    expect(rec).toBeDefined();
    expect(rec!.abi).toBe(ABI_VERSION);
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

  test("preserves a null hole inside a stored signature", () => {
    class HoleCtor {}

    defineDeps(HoleCtor, [["token:ILogger", null, "token:IDb"]]);

    const rec = getDeps(HoleCtor);
    expect(rec!.signatures[0]).toEqual(["token:ILogger", null, "token:IDb"]);
  });

  test("keys by exact constructor — subclass does NOT inherit parent's record", () => {
    class Parent {}
    class Child extends Parent {}

    defineDeps(Parent, [["token:IParent"]]);

    // getDeps(Child) must return undefined; the WeakMap is keyed by the exact
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
    expect(rec!.signatures[0]).toEqual(["dec:ILogger", null, "dec:IDb"]);
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
    expect(rec!.signatures[0]).toEqual(["fc:ILogger", null, "fc:IDb"]);
  });

  test("builder is the same object (for chaining identity)", () => {
    class ForCtorChainId {}

    const builder = forCtor(ForCtorChainId);
    const returned = builder.signature("fc:IFoo");
    expect(returned).toBe(builder);
  });
});
