import { test, expect, describe } from "bun:test";
import type {
  OverloadedParameters,
  OverloadedConstructorParameters,
} from "@fnioc/core";

// TYPE-LEVEL contract for the overload-faithful parameter-tuple utilities. This
// file is type-checked by `integration:lint` (plain tsc over test/**); the real
// coverage is the compile, which fails if any positive assertion below stops
// type-checking. The runtime assertion is a placeholder — the utilities erase
// completely. These exercise the SHIPPED `@fnioc/core` exports (the same ones the
// transformer re-exports and the rest-parameter expansion consumes).

// ── type-assert helpers ───────────────────────────────────────────────────────

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

interface IA {}
interface IB {}
interface IC {}

// ── OverloadedParameters: every overload's tuple, not just the last ───────────

declare function fn(a: IA): number;
declare function fn(a: IB, b: IC): string;
// The builtin `Parameters` would see only `[a: IB, b: IC]`; the overload-faithful
// form recovers BOTH signatures as a union.
type _fn = Expect<Equal<OverloadedParameters<typeof fn>, [a: IA] | [a: IB, b: IC]>>;

declare function single(a: IA, b: IB): number;
type _fnSingle = Expect<Equal<OverloadedParameters<typeof single>, [a: IA, b: IB]>>;

// ── OverloadedConstructorParameters: the construct-signature counterpart ───────

class C {
  constructor(a: IA);
  constructor(a: IB, b: IC);
  constructor(...args: any[]) {}
}
// The union of BOTH constructor overloads' parameter tuples.
type _ctor = Expect<
  Equal<OverloadedConstructorParameters<typeof C>, [a: IA] | [a: IB, b: IC]>
>;

class SingleCtor {
  constructor(a: IA, b: IB) {}
}
// A single-overload ctor → its one tuple.
type _ctorSingle = Expect<
  Equal<OverloadedConstructorParameters<typeof SingleCtor>, [a: IA, b: IB]>
>;

class ZeroArg {
  constructor() {}
}
// A zero-arg ctor → the empty tuple.
type _ctorZero = Expect<Equal<OverloadedConstructorParameters<typeof ZeroArg>, []>>;

describe("overload-faithful parameter type utilities", () => {
  test("the OverloadedParameters / OverloadedConstructorParameters surface compiles (see file-level asserts)", () => {
    // The real coverage is the integration:lint compile of this file; this keeps
    // the runtime test non-empty.
    expect(true).toBe(true);
  });
});

// Reference the type aliases so unused-local lint does not strip the asserts.
export type _Asserts = [_fn, _fnSingle, _ctor, _ctorSingle, _ctorZero];
