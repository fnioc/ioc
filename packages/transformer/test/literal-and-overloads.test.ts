import { test, expect, describe } from "bun:test";
import { transform, fixture } from "./harness.js";
import { DiagnosticCode } from "../src/index.js";

// Rule 2 (LiteralRef value supply) + the union-unified optional handling +
// declared-overload signatures + the wide-primitive (WP) tokenization rules.
//
// Emit shapes:
//   - a singular literal param `"dev"` / `42` / `true` / `1n`  →  { value: ... }
//   - whole-type `void` / `undefined`                         →  { value: void 0 }
//   - whole-type `null`                                       →  { value: null }
//   - any optional param  →  union(<non-nullish slots>, { value: void 0 }) (last)
//   - `X | null`          →  union(X, { value: null })
//   - a pure-literal union `"a" | "b"`  →  one sorted token (NOT a union slot)
//   - every intrinsic     →  its keyword token (Rule 1); `boolean` from `true|false`

/** Pull the `[[...]]` signature literal out of a defineDeps(...) call. */
function depsArrayFor(output: string, ctor: string): string {
  const hoistMatch = output.match(new RegExp(`const (ɵreg\\d+) = ${ctor};`));
  if (!hoistMatch) {throw new Error(`no hoisted const for ${ctor} in:\n${output}`);}
  const regName = hoistMatch[1]!;
  const marker = `defineDeps(${regName}, `;
  const start = output.indexOf(marker);
  if (start < 0) {throw new Error(`no defineDeps for ${regName} in:\n${output}`);}
  const from = start + marker.length;
  const end = output.indexOf("]);", from);
  return output.slice(from, end + 1);
}

function emitFor(ctorBody: string, extra = ""): string {
  const src = `
    ${extra}
    interface IMarker {}
    class C implements IMarker {
      ${ctorBody}
    }
    declare const services: any;
    services.add<IMarker>(C).as<"singleton">();
  `;
  const { output, diagnostics } = transform(fixture(src));
  expect(
    diagnostics.filter((d) => d.code === DiagnosticCode.UnderivableToken).length,
  ).toBe(0);
  return depsArrayFor(output, "C");
}

// ── Rule 2: singular literals supply their value (LiteralRef emission) ────────

describe("LiteralRef emission — singular literals (Rule 2)", () => {
  test("string / number / boolean / bigint literals each emit { value }", () => {
    expect(emitFor(`constructor(a: "dev", b: 42, c: true, d: 1n) {}`)).toBe(
      '[[{ value: "dev" }, { value: 42 }, { value: true }, { value: 1n }]]',
    );
  });

  test("negative number and negative bigint round-trip as unary-minus literals", () => {
    expect(emitFor(`constructor(a: -7, b: -3n) {}`)).toBe(
      "[[{ value: -7 }, { value: -3n }]]",
    );
  });

  test("false literal emits { value: false }", () => {
    expect(emitFor(`constructor(a: false) {}`)).toBe("[[{ value: false }]]");
  });
});

// ── Rule 2: whole-type void / undefined / null singletons ────────────────────

describe("LiteralRef emission — void / undefined / null singletons (Rule 2)", () => {
  test("a `void` param supplies undefined (not a token, no overload)", () => {
    expect(emitFor(`constructor(a: void) {}`)).toBe("[[{ value: void 0 }]]");
  });

  test("whole-type undefined and null supply their values", () => {
    expect(emitFor(`constructor(a: undefined, b: null) {}`)).toBe(
      "[[{ value: void 0 }, { value: null }]]",
    );
  });

  test("`never` is NOT a singleton — it stays the Rule-1 token", () => {
    expect(emitFor(`constructor(a: never) {}`)).toBe('[["never"]]');
  });
});

// ── Rule 1: WP-series — primitives tokenize by keyword ───────────────────────

describe("WP-series — wide primitives tokenize by keyword (Rule 1)", () => {
  test("WP-1/2/3: standalone string / number / boolean → bare keyword token", () => {
    expect(emitFor(`constructor(a: string, b: number, c: boolean) {}`)).toBe(
      '[["string", "number", "boolean"]]',
    );
  });

  test("WP-4/5/6: primitives inside a union → bare keyword members", () => {
    expect(
      emitFor(`constructor(a: string | IFoo) {}`, "interface IFoo {}"),
    ).toBe('[[{ union: ["string", "./app/IFoo"] }]]');
    expect(
      emitFor(`constructor(a: number | IFoo) {}`, "interface IFoo {}"),
    ).toBe('[[{ union: ["number", "./app/IFoo"] }]]');
  });

  test("WP-7: `true | false` is the wide boolean type → bare token 'boolean'", () => {
    expect(emitFor(`constructor(a: true | false) {}`)).toBe('[["boolean"]]');
  });

  test("WP-8: symbol tokenizes by keyword", () => {
    expect(emitFor(`constructor(a: symbol) {}`)).toBe('[["symbol"]]');
  });

  test("WP-9: any / unknown tokenize; bigint tokenizes by keyword", () => {
    expect(emitFor(`constructor(a: any, b: unknown, c: bigint) {}`)).toBe(
      '[["any", "unknown", "bigint"]]',
    );
  });

  test("WP-10: a singular `\"hello\"` literal supplies its value (Rule 2), not a token", () => {
    expect(emitFor(`constructor(mode: "hello") {}`)).toBe(
      '[[{ value: "hello" }]]',
    );
  });
});

// ── Optional handling unified on union (no overload expansion) ───────────────

describe("optional params lower to union(<non-nullish>, { value: undefined })", () => {
  test("`dep?: IFoo` → single signature with a union fallback", () => {
    expect(
      emitFor(`constructor(dep?: IFoo) {}`, "interface IFoo {}"),
    ).toBe('[[{ union: ["./app/IFoo", { value: void 0 }] }]]');
  });

  test("`dep: IFoo | undefined` → identical union fallback", () => {
    expect(
      emitFor(`constructor(dep: IFoo | undefined) {}`, "interface IFoo {}"),
    ).toBe('[[{ union: ["./app/IFoo", { value: void 0 }] }]]');
  });

  test("`p: string = 'x'` default initializer → union('string', { value: undefined })", () => {
    expect(
      emitFor(`constructor(a: IFoo, p: string = "x") {}`, "interface IFoo {}"),
    ).toBe('[["./app/IFoo", { union: ["string", { value: void 0 }] }]]');
  });

  test("interior `a: IFoo | undefined, b: IBar` keeps b (union fallback expresses it)", () => {
    // Overload-dropping could not represent this; the per-param union does.
    expect(
      emitFor(
        `constructor(a: IFoo | undefined, b: IBar) {}`,
        "interface IFoo {} interface IBar {}",
      ),
    ).toBe(
      '[[{ union: ["./app/IFoo", { value: void 0 }] }, "./app/IBar"]]',
    );
  });

  test("`dep?: IFoo | IBar` → ONE signature union(IFoo, IBar, { value: undefined }) (GAP9)", () => {
    // Under union unification this is a single signature, NOT two overloads.
    expect(
      emitFor(
        `constructor(dep?: IFoo | IBar) {}`,
        "interface IFoo {} interface IBar {}",
      ),
    ).toBe(
      '[[{ union: ["./app/IFoo", "./app/IBar", { value: void 0 }] }]]',
    );
  });

  test("`X | null` → union(X, { value: null })", () => {
    expect(
      emitFor(`constructor(a: IFoo | null) {}`, "interface IFoo {}"),
    ).toBe('[[{ union: ["./app/IFoo", { value: null }] }]]');
  });

  test("optional pure-literal union `mode?: \"a\" | \"b\"` keeps the sorted literal token", () => {
    expect(emitFor(`constructor(mode?: "a" | "b") {}`)).toBe(
      '[[{ union: ["\\"a\\" | \\"b\\"", { value: void 0 }] }]]',
    );
  });
});

// ── Inline non-literal unions + GAP10/11 ─────────────────────────────────────

describe("inline union slots (GAP10/11)", () => {
  test("GAP11: declaration order preserved, non-alphabetical IBeta | IAlpha", () => {
    expect(
      emitFor(`constructor(dep: IBeta | IAlpha) {}`, "interface IAlpha {} interface IBeta {}"),
    ).toBe('[[{ union: ["./app/IBeta", "./app/IAlpha"] }]]');
  });

  test("GAP10: pure literal union is NOT a union slot — one sorted literal token", () => {
    expect(emitFor(`constructor(dep: "a" | "b") {}`)).toBe('[["\\"a\\" | \\"b\\""]]');
  });

  test("pure number literal union → one sorted token", () => {
    expect(emitFor(`constructor(dep: 2 | 1) {}`)).toBe('[["1 | 2"]]');
  });

  test("mixed literal + interface union → real union with a LiteralRef member", () => {
    expect(
      emitFor(`constructor(dep: "dev" | IFoo) {}`, "interface IFoo {}"),
    ).toBe('[[{ union: [{ value: "dev" }, "./app/IFoo"] }]]');
  });
});

// ── Declared constructor overloads ───────────────────────────────────────────

describe("declared constructor overloads → one signature each (impl ignored)", () => {
  test("two declared overloads emit two signatures; the impl is ignored", () => {
    const src = `
      interface IFoo {}
      interface IBar {}
      interface IMarker {}
      class C implements IMarker {
        constructor(a: IFoo);
        constructor(a: IFoo, b: IBar);
        constructor(a: IFoo, b?: IBar) {}
      }
      declare const services: any;
      services.add<IMarker>(C).as<"singleton">();
    `;
    const { output, diagnostics } = transform(fixture(src));
    expect(
      diagnostics.filter((d) => d.code === DiagnosticCode.UnderivableToken).length,
    ).toBe(0);
    // Exactly two signatures (one per declared overload); NO third from the impl.
    expect(depsArrayFor(output, "C")).toBe(
      '[["./app/IFoo"], ["./app/IFoo", "./app/IBar"]]',
    );
  });

  test("an optional param INSIDE a declared overload gets the union fallback", () => {
    const src = `
      interface IFoo {}
      interface IBar {}
      interface IMarker {}
      class C implements IMarker {
        constructor(a: IFoo);
        constructor(a: IFoo, b?: IBar);
        constructor(a: IFoo, b?: IBar) {}
      }
      declare const services: any;
      services.add<IMarker>(C).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    // Second overload's optional b → union(IBar, { value: undefined }), one sig each.
    expect(depsArrayFor(output, "C")).toBe(
      '[["./app/IFoo"], ["./app/IFoo", { union: ["./app/IBar", { value: void 0 }] }]]',
    );
  });
});

// ── resolve<T>() lowering (Rule 2) ───────────────────────────────────────────

describe("resolve<T>() singular-literal lowering (Rule 2)", () => {
  function resolveEmit(typeArg: string): string {
    const src = `declare const scope: any; const x = scope.resolve<${typeArg}>();`;
    const { output } = transform(fixture(src));
    return output.match(/const x = (.*);/)![1]!;
  }

  test("resolve<\"dev\">() lowers to the value expression \"dev\" (no resolve call)", () => {
    expect(resolveEmit(`"dev"`)).toBe('"dev"');
  });

  test("resolve<42>() / resolve<true>() / resolve<1n>() supply the value", () => {
    expect(resolveEmit("42")).toBe("42");
    expect(resolveEmit("true")).toBe("true");
    expect(resolveEmit("1n")).toBe("1n");
  });

  test("resolve<void>() / resolve<undefined>() lower to `void 0`; resolve<null>() to `null`", () => {
    expect(resolveEmit("void")).toBe("void 0");
    expect(resolveEmit("undefined")).toBe("void 0");
    expect(resolveEmit("null")).toBe("null");
  });

  test("resolve<\"a\" | \"b\">() (a literal UNION) stays a token resolve call", () => {
    expect(resolveEmit(`"a" | "b"`)).toBe('scope.resolve("\\"a\\" | \\"b\\"")');
  });
});
