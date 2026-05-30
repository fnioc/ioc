import { test, expect } from "bun:test";
import { ABI_VERSION } from "@fnioc/core";

// Smoke test: the package is importable and the ABI surface is present.
// Real coverage (defineDeps, the global WeakMap, @signature, forCtor) lands
// with the Phase 1 implementation.
test("@fnioc/core exports ABI_VERSION", () => {
  expect(ABI_VERSION).toBe(1);
});
