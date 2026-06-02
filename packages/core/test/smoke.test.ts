import { test, expect } from "bun:test";
import { defineDeps, getDeps, union } from "@fnioc/core";

// Smoke test: the package is importable and the public surface is present.
test("@fnioc/core exports a usable surface", () => {
  class SmokeCtor {}
  defineDeps(SmokeCtor, [["smoke:IFoo"]]);
  expect(getDeps(SmokeCtor)!.signatures[0]).toEqual(["smoke:IFoo"]);
});

test("union() helper is callable and returns a Union slot", () => {
  const u = union("smoke:A", "smoke:B");
  expect(u).toEqual({ union: ["smoke:A", "smoke:B"] });
});
