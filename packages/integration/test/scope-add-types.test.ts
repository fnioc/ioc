import { test, expect, describe } from "bun:test";
import { ServiceManifest } from "@fnioc/di";
import type { ProperCase, ScopeAddMethods, ValidScopes } from "@fnioc/di";

// TYPE-LEVEL contract for per-scope `add${ProperCase<K>}` methods. This file is
// type-checked by `integration:lint` (plain tsc over test/**, with the
// @fnioc/transformer augmentation in the program via the tsconfig `types`
// array). The runtime assertions are token placeholders — the real coverage is
// the compile, which fails if any `@ts-expect-error` below stops firing or any
// positive assertion stops type-checking.

// ── type-assert helpers ───────────────────────────────────────────────────────

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

// ── ProperCase ────────────────────────────────────────────────────────────────

type _pc1 = Expect<Equal<ProperCase<"request">, "Request">>;
type _pc2 = Expect<Equal<ProperCase<"singleton">, "Singleton">>;
type _pc3 = Expect<Equal<ProperCase<"a">, "A">>;
type _pc4 = Expect<Equal<ProperCase<"">, "">>;

// ── ValidScopes: accepts lowercase-first, rejects the collisions ──────────────

type _vs_ok1 = Expect<Equal<ValidScopes<"request">, "request">>;
type _vs_ok2 = Expect<
  Equal<ValidScopes<"request" | "session">, "request" | "session">
>;
// Capitalized-first → never (would mint a method colliding with add<I> casing
// and break ProperCase injectivity).
type _vs_bad1 = Expect<Equal<ValidScopes<"Request">, never>>;
type _vs_bad2 = Expect<Equal<ValidScopes<"Factory">, never>>;
// Collides with the existing add / addFactory / addValue methods.
type _vs_bad3 = Expect<Equal<ValidScopes<"factory">, never>>;
type _vs_bad4 = Expect<Equal<ValidScopes<"value">, never>>;
type _vs_bad5 = Expect<Equal<ValidScopes<"">, never>>;
// A union where ANY member is invalid collapses the whole union to never
// (non-distributive guard).
type _vs_bad6 = Expect<Equal<ValidScopes<"request" | "Factory">, never>>;

// ── ScopeAddMethods: the right names are minted ───────────────────────────────

type Methods = ScopeAddMethods<"singleton" | "request">;
type _m1 = Expect<Equal<keyof Methods, "addSingleton" | "addRequest">>;

// ── the construction-site guard + authored forms ──────────────────────────────

interface ILogger {}
interface IClock {}
class ConsoleLogger implements ILogger {}
class SystemClock implements IClock {}

// Authored single-arg forms NEVER execute at runtime (the transformer lowers
// them; without it they throw). This function is type-checked but never called —
// it carries the compile-time-only assertions for the authored forms + the
// construction-site guard. Exported so unused-local lint does not strip it.
export function _typeOnlyAsserts(): void {
  const services = new ServiceManifest<"singleton" | "request">();

  // The minted methods exist with the expected names and authored single-arg
  // forms (lowered by the transformer at build time).
  services.addSingleton<ILogger>(ConsoleLogger);
  services.addRequest<IClock>(SystemClock);
  // No-type-arg authored form.
  services.addSingleton(ConsoleLogger);

  // A non-existent scope's method does not exist.
  // @ts-expect-error addReview is not a declared scope's method
  services.addReview<ILogger>(ConsoleLogger);

  // Construction-site guard: invalid scope unions fail to construct.
  // @ts-expect-error "Request" is capitalized-first → invalid scope tag
  new ServiceManifest<"Request">();
  // @ts-expect-error "factory" collides with addFactory
  new ServiceManifest<"factory">();
  // @ts-expect-error "" would mint a bare `add`
  new ServiceManifest<"">();
  // @ts-expect-error a union with one invalid member is rejected as a whole
  new ServiceManifest<"request" | "Factory">();

  // The default scope still constructs with no args.
  new ServiceManifest();
  new ServiceManifest<"request" | "session">();
}

describe("per-scope method types", () => {
  test("the per-scope method type surface compiles (see file-level asserts)", () => {
    // The real coverage is the integration:lint compile of this file; the runtime
    // build() check just keeps the test non-empty.
    const services = new ServiceManifest<"singleton" | "request">();
    expect(typeof services.build).toBe("function");
  });
});

// Reference the type aliases so unused-local lint does not strip the asserts.
export type _Asserts = [
  _pc1,
  _pc2,
  _pc3,
  _pc4,
  _vs_ok1,
  _vs_ok2,
  _vs_bad1,
  _vs_bad2,
  _vs_bad3,
  _vs_bad4,
  _vs_bad5,
  _vs_bad6,
  _m1,
];
