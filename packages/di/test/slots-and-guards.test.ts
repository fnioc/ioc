import { test, expect, describe } from "bun:test";
import {
  union,
  typeArg,
  isFactoryRef,
  isScopeRef,
  isUnionSlot,
  isLiteralRef,
  isTypeArgRef,
} from "@fnioc/di";
import type { DepSlot } from "@fnioc/core";

// The slot constructors + type guards — relocated here from @fnioc/core when core
// became a pure-types package. They are runtime values that live with the engine
// that runs them; a di consumer reaches them through the @fnioc/di import.

test("union() helper is callable and returns a Union slot", () => {
  const u = union("smoke:A", "smoke:B");
  expect(u).toEqual({ union: ["smoke:A", "smoke:B"] });
});

test("typeArg() helper returns a TypeArgRef slot", () => {
  expect(typeArg(1)).toEqual({ typeArg: 1 });
});

describe("slot type guards", () => {
  const cases: { slot: DepSlot; kind: string }[] = [
    { slot: "pkg:IFoo", kind: "token" },
    { slot: { type: "pkg:IFoo" }, kind: "factory" },
    { slot: { scope: true }, kind: "scope" },
    { slot: { union: ["pkg:A", "pkg:B"] }, kind: "union" },
    { slot: { value: 42 }, kind: "literal" },
    { slot: { value: undefined }, kind: "literal" },
    { slot: { typeArg: 2 }, kind: "typearg" },
  ];

  test("each guard matches exactly its own slot kind", () => {
    for (const { slot, kind } of cases) {
      expect(isFactoryRef(slot)).toBe(kind === "factory");
      expect(isScopeRef(slot)).toBe(kind === "scope");
      expect(isUnionSlot(slot)).toBe(kind === "union");
      expect(isLiteralRef(slot)).toBe(kind === "literal");
      expect(isTypeArgRef(slot)).toBe(kind === "typearg");
    }
  });
});
