import { test, expect, describe } from "bun:test";
import { transform, fixture } from "./harness.js";

// Overload-faithful REST-parameter expansion for factory signatures. A factory
// rest parameter whose type is a TUPLE (`...args: [A, B]`) expands into positional
// slots; a rest whose type is a UNION of tuples (`...args: [A] | [B, C]`) emits one
// dep signature per member. Fed by `OverloadedConstructorParameters<C>`, this is
// how an overloaded constructor's shape survives into a factory registration —
// one signature per constructor overload.

describe("rest-parameter expansion (overload-faithful factory params)", () => {
  test("rest tuple (...args: [A, B]) expands into a 2-slot signature", () => {
    const src = `
      interface IA {}
      interface IB {}
      interface IThing {}
      declare const services: any;
      services.addFactory<IThing>((...args: [IA, IB]) => ({} as IThing));
    `;
    const { output } = transform(fixture(src));
    expect(output).toContain('[["./app:IA", "./app:IB"]]');
  });

  test("labeled tuple elements ([a: A, b: B]) read through transparently", () => {
    const src = `
      interface IA {}
      interface IB {}
      interface IThing {}
      declare const services: any;
      services.addFactory<IThing>((...args: [a: IA, b: IB]) => ({} as IThing));
    `;
    const { output } = transform(fixture(src));
    expect(output).toContain('[["./app:IA", "./app:IB"]]');
  });

  test("empty tuple (...args: []) expands into a zero-slot signature", () => {
    const src = `
      interface IThing {}
      declare const services: any;
      services.addFactory<IThing>((...args: []) => ({} as IThing));
    `;
    const { output } = transform(fixture(src));
    // Zero-slot signature — one empty signature, not a missing one.
    expect(output).toContain('addFactory("./app:IThing"');
    expect(output).toContain("[[]]");
  });

  test("union of tuples (...args: [A] | [B, C]) emits ONE signature per member", () => {
    const src = `
      interface IA {}
      interface IB {}
      interface IC {}
      interface IThing {}
      declare const services: any;
      services.addFactory<IThing>((...args: [IA] | [IB, IC]) => ({} as IThing));
    `;
    const { output } = transform(fixture(src));
    // Two signatures, one per union member tuple.
    expect(output).toContain('[["./app:IA"], ["./app:IB", "./app:IC"]]');
  });

  test("leading fixed params precede the expanded rest tail", () => {
    const src = `
      interface IA {}
      interface IB {}
      interface IC {}
      interface IThing {}
      declare const services: any;
      services.addFactory<IThing>((a: IA, ...args: [IB, IC]) => ({} as IThing));
    `;
    const { output } = transform(fixture(src));
    // (a: A, ...args: [B, C]) → [A, B, C] in one signature.
    expect(output).toContain('[["./app:IA", "./app:IB", "./app:IC"]]');
  });

  test("an optional tuple element gains the { value: undefined } fallback", () => {
    const src = `
      interface IA {}
      interface IB {}
      interface IThing {}
      declare const services: any;
      services.addFactory<IThing>((...args: [IA, IB?]) => ({} as IThing));
    `;
    const { output } = transform(fixture(src));
    // The optional B slot is union(B, undefined-fallback), the LiteralRef last.
    expect(output).toContain(
      '[["./app:IA", { union: ["./app:IB", { value: void 0 }] }]]',
    );
  });
});

describe("OverloadedConstructorParameters end-to-end", () => {
  test("an overloaded ctor's factory lowers to one signature per overload", () => {
    // The shipped `@fnioc/core` algorithm, inlined so the harness (which cannot
    // resolve a real package) can resolve the type. A factory rest parameter typed
    // `OverloadedConstructorParameters<typeof C>` is the union of every ctor
    // overload's tuple → one dep signature per overload.
    const src = `
      interface IA {}
      interface IB {}
      interface IC {}
      interface IThing {}
      class C {
        constructor(a: IA);
        constructor(a: IB, b: IC);
        constructor(...args: any[]) {}
      }
      type OverloadProps<T> = Pick<T, keyof T>;
      type OverloadUnionRecursive<TOverload, TAccumulator = unknown> =
        TOverload extends new (...args: infer TArgs) => infer TReturn
          ? TAccumulator extends TOverload ? never
            : | OverloadUnionRecursive<TAccumulator & TOverload, TAccumulator & (new (...args: TArgs) => TReturn) & OverloadProps<TOverload>>
              | (new (...args: TArgs) => TReturn)
          : never;
      type OverloadUnion<T extends new (...args: any[]) => any> =
        Exclude<OverloadUnionRecursive<(new () => never) & T>, T extends new () => never ? never : new () => never>;
      type OverloadedConstructorParameters<T extends new (...args: any[]) => any> =
        ConstructorParameters<OverloadUnion<T>>;
      declare const services: any;
      services.addFactory<IThing>((...args: OverloadedConstructorParameters<typeof C>) => ({} as IThing));
    `;
    const { output } = transform(fixture(src));
    expect(output).toContain('addFactory("./app:IThing"');
    // Both constructor overloads survive as their own signature.
    expect(output).toContain('["./app:IA"]');
    expect(output).toContain('["./app:IB", "./app:IC"]');
  });
});
