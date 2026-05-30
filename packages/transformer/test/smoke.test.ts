import { test, expect } from "bun:test";
import { TARGET_ABI_VERSION } from "@fnioc/transformer";

// Smoke test: @fnioc/transformer resolves @fnioc/core and exposes its target
// ABI. Real coverage (token gen, dep extraction, lowering, diagnostics) lands
// with Phase 2B.
test("@fnioc/transformer targets the @fnioc/core ABI", () => {
  expect(TARGET_ABI_VERSION).toBe(1);
});
