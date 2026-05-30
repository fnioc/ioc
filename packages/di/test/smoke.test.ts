import { test, expect } from "bun:test";
import { DiBuilder, hole } from "@fnioc/di";

// Smoke test: @fnioc/di is importable, the engine surface is present, and the
// @fnioc/core re-export resolves across the workspace boundary. Exhaustive
// coverage lives in the per-concern suites alongside this file.
test("@fnioc/di exports the engine and re-exports the core substrate", () => {
  expect(typeof DiBuilder).toBe("function");
  expect(hole).toBeNull();

  const services = new DiBuilder<"singleton">();
  class Probe {
    public readonly ok = true;
  }
  services.add("pkg:IProbe", Probe).as("singleton");
  const probe = services.createScope("singleton").resolve<Probe>("pkg:IProbe");
  expect(probe.ok).toBe(true);
});
