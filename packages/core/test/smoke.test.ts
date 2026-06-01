import { test, expect } from "bun:test";
import { hole, defineDeps, getDeps } from "@fnioc/core";

// Smoke test: the package is importable and the public surface is present.
test("@fnioc/core exports a usable surface", () => {
  expect(hole).toBeNull();

  class SmokeCtor {}
  defineDeps(SmokeCtor, [["smoke:IFoo"]]);
  expect(getDeps(SmokeCtor)!.signatures[0]).toEqual(["smoke:IFoo"]);
});
