import { test, expect, describe } from "bun:test";
import { transform, fixture, type VirtualFiles } from "./harness.js";
import { DiagnosticCode } from "../src/index.js";

// Factory detection (PRD §7 / §8). A constructor parameter whose type ANNOTATION
// is an inline function-type literal (`() => IFoo`) emits a
// `{ type: "<token-for-the-return-type>" }` slot — the `FactoryRef` ABI shape
// — instead of a plain token. A NAMED function-interface reference is the
// deliberate opt-out and resolves to its own normal token. Detection is purely
// syntactic (the annotation's shape), never the resolved type.

/**
 * Pull the `[[...]]` signature array text out of the inline registration call
 * for the given class/factory. Signatures ride ON the registration as the third
 * argument: `add("token", Ctor, [[...]])` / `addFactory("token", fn, [[...]])`.
 */
function depsArrayFor(output: string, ctor: string): string {
  const marker = `, ${ctor}, `;
  const at = output.indexOf(marker);
  if (at < 0) {throw new Error(`no inline signature for ${ctor} in:\n${output}`);}
  const start = output.indexOf("[", at + marker.length);
  if (start < 0) {throw new Error(`no signature array for ${ctor} in:\n${output}`);}
  let depth = 0;
  for (let i = start; i < output.length; i++) {
    const ch = output[i];
    if (ch === "[") {
      depth += 1;
    } else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {return output.slice(start, i + 1);}
    }
  }
  throw new Error(`unbalanced signature array for ${ctor} in:\n${output}`);
}

describe("factory detection", () => {
  test("inline () => IFoo emits a { type: token } slot", () => {
    const src = `
      interface IFoo {}
      interface ISvc {}
      class Svc implements ISvc {
        constructor(makeFoo: () => IFoo) {}
      }
      declare const services: any;
      services.add<ISvc>(Svc).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    expect(depsArrayFor(output, "Svc")).toBe('[[{ type: "./app/IFoo" }]]');
  });

  test("declared params are emitted as FactoryRef.params in declared order", () => {
    const src = `
      interface IFoo {}
      interface ISvc {}
      class B2 {}
      class D4 {}
      class Svc implements ISvc {
        constructor(makeFoo: (a: B2, b: D4) => IFoo) {}
      }
      declare const services: any;
      services.add<ISvc>(Svc).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    // Declared params become caller-supplied tokens in authored order.
    expect(depsArrayFor(output, "Svc")).toBe(
      '[[{ type: "./app/IFoo", params: ["./app/B2", "./app/D4"] }]]',
    );
  });

  test("named function-interface is NOT a factory (the opt-out)", () => {
    const src = `
      interface IFoo {}
      interface IFooThunk { (): IFoo }
      interface ISvc {}
      class Svc implements ISvc {
        constructor(thunk: IFooThunk) {}
      }
      declare const services: any;
      services.add<ISvc>(Svc).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    // Resolves to the named interface's OWN token, not a factory ref.
    expect(depsArrayFor(output, "Svc")).toBe('[["./app/IFooThunk"]]');
    expect(output).not.toContain("factory:");
  });

  test("Promise<IFoo> return type → the honest closed-generic factory token", () => {
    const src = `
      interface IFoo {}
      interface ISvc {}
      class Svc implements ISvc {
        constructor(makeFoo: () => Promise<IFoo>) {}
      }
      declare const services: any;
      services.add<ISvc>(Svc).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    // Honest token-split: the factory's Promise<IFoo> return is NOT unwrapped —
    // its FactoryRef type is the closed-generic token `Promise<./app/IFoo>`.
    expect(depsArrayFor(output, "Svc")).toBe('[[{ type: "Promise<./app/IFoo>" }]]');
  });

  test("factory mixes with plain tokens in one signature", () => {
    const src = `
      interface ILogger {}
      interface IFoo {}
      interface ISvc {}
      class Svc implements ISvc {
        constructor(log: ILogger, makeFoo: () => IFoo) {}
      }
      declare const services: any;
      services.add<ISvc>(Svc).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    expect(depsArrayFor(output, "Svc")).toBe(
      '[["./app/ILogger", { type: "./app/IFoo" }]]',
    );
  });

  test("a factory whose return type is a primitive keys on the keyword token (Rule 1)", () => {
    // Rule 1: `() => string` derives the factory's produced token "string" — the
    // return type now tokenizes by its keyword, no hard error. The factory is a
    // `{ type: "string" }` slot (a factory producing the registered `string`).
    const src = `
      interface ISvc {}
      class Svc implements ISvc {
        constructor(makeName: () => string) {}
      }
      declare const services: any;
      services.add<ISvc>(Svc).as<"singleton">();
    `;
    const { output, diagnostics } = transform(fixture(src));
    expect(
      diagnostics.filter((d) => d.code === DiagnosticCode.UnderivableToken).length,
    ).toBe(0);
    expect(depsArrayFor(output, "Svc")).toBe('[[{ type: "string" }]]');
  });

  test("class expression with two construct overloads emits both signatures (Fix 2)", () => {
    // `extractCtorReferenceSignature` must iterate ALL construct signatures, not
    // just the first. A const-bound class expression with declared overloads is
    // the representative shape.
    const src = `
      interface IFoo {}
      interface IBar {}
      interface IMarker {}
      const Impl = class implements IMarker {
        constructor(a: IFoo);
        constructor(a: IFoo, b: IBar);
        constructor(a: IFoo, b?: IBar) {}
      };
      declare const services: any;
      services.add<IMarker>(Impl).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    // Both declared overloads must appear — the impl is ignored.
    expect(depsArrayFor(output, "Impl")).toBe(
      '[["./app/IFoo"], ["./app/IFoo", "./app/IBar"]]',
    );
  });

  test("factory reference with two call overloads emits both signatures (Fix 2)", () => {
    // `extractFactoryReferenceSignature` must iterate ALL call signatures. A
    // named factory function with declared overloads is the representative shape.
    const src = `
      interface IFoo {}
      interface IBar {}
      interface IMarker {}
      declare function makeMarker(a: IFoo): IMarker;
      declare function makeMarker(a: IFoo, b: IBar): IMarker;
      declare const services: any;
      services.add<IMarker>(makeMarker).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    // Both call overloads must appear.
    expect(depsArrayFor(output, "makeMarker")).toBe(
      '[["./app/IFoo"], ["./app/IFoo", "./app/IBar"]]',
    );
  });

  test("package-public factory return type keys on the package token", () => {
    const files: VirtualFiles = {
      "/proj/node_modules/your-lib/package.json": JSON.stringify({
        name: "your-lib",
        version: "1.0.0",
        exports: { "./contracts": "./contracts/index.js" },
      }),
      "/proj/node_modules/your-lib/contracts/index.d.ts": `export interface IFoo {}`,
      "/proj/src/app.ts": `
        import { IFoo } from "your-lib/contracts";
        interface ISvc {}
        class Svc implements ISvc {
          constructor(makeFoo: () => IFoo) {}
        }
        declare const services: any;
        services.add<ISvc>(Svc).as<"singleton">();
      `,
    };
    const { outputs } = transform(files, { entry: ["/proj/src/app.ts"] });
    const out = outputs["/proj/src/app.ts"]!;
    expect(depsArrayFor(out, "Svc")).toBe(
      '[[{ type: "your-lib:contracts/IFoo" }]]',
    );
  });
});

describe("declared factory params → caller-supplied params (caller wins over registration)", () => {
  test("(a: ILogger) => IReport emits { type, params: [ILogger token] }", () => {
    const src = `
      interface ILogger {}
      interface IReport {}
      interface ISvc {}
      class Svc implements ISvc {
        constructor(makeReport: (a: ILogger) => IReport) {}
      }
      declare const services: any;
      services.add<ISvc>(Svc).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    expect(depsArrayFor(output, "Svc")).toBe(
      '[[{ type: "./app/IReport", params: ["./app/ILogger"] }]]',
    );
  });

  test("zero-arg factory emits bare { type } (strict mode, no params field)", () => {
    const src = `
      interface IReport {}
      interface ISvc {}
      class Svc implements ISvc {
        constructor(makeReport: () => IReport) {}
      }
      declare const services: any;
      services.add<ISvc>(Svc).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    expect(depsArrayFor(output, "Svc")).toBe('[[{ type: "./app/IReport" }]]');
  });

  test("mixed (table: string, log: ILogger) => IRepo emits params in declared order", () => {
    const src = `
      interface ILogger {}
      interface IRepo {}
      interface ISvc {}
      class Svc implements ISvc {
        constructor(makeRepo: (table: string, log: ILogger) => IRepo) {}
      }
      declare const services: any;
      services.add<ISvc>(Svc).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    expect(depsArrayFor(output, "Svc")).toBe(
      '[[{ type: "./app/IRepo", params: ["string", "./app/ILogger"] }]]',
    );
  });
});
