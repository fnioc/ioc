import { test, expect } from "bun:test";
import { transform, createTransformerFactory } from "@fnioc/transformer";

// Smoke test: @fnioc/transformer resolves and exposes its ts-patch entry points.
// Real coverage (token gen, dep extraction, lowering, diagnostics) lives in the
// sibling test files.
test("@fnioc/transformer exposes its ts-patch entry points", () => {
  expect(typeof transform).toBe("function");
  expect(typeof createTransformerFactory).toBe("function");
});
