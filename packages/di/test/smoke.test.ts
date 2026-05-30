import { test, expect } from "bun:test";
import { SUBSTRATE_ABI_VERSION } from "@fnioc/di";

// Smoke test: @fnioc/di resolves @fnioc/core across the workspace boundary.
// Real coverage (DiBuilder, scopes, resolution, disposal) lands with Phase 2A.
test("@fnioc/di resolves the @fnioc/core substrate", () => {
  expect(SUBSTRATE_ABI_VERSION).toBe(1);
});
