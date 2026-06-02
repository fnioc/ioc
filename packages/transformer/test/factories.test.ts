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
 * Pull the `[[...]]` signature array text out of a defineDeps(...) call for the
 * given class. The transformer always hoists: `const ɵregN = Ctor;` followed by
 * `defineDeps(ɵregN, [[...]]);`. We find the hoisted const to resolve the name.
 */
function depsArrayFor(output: string, ctor: string): string {
  const hoistMatch = output.match(new RegExp(`const (ɵreg\\d+) = ${ctor};`));
  if (!hoistMatch) throw new Error(`no hoisted const for ${ctor} in:\n${output}`);
  const regName = hoistMatch[1]!;
  const marker = `defineDeps(${regName}, `;
  const start = output.indexOf(marker);
  if (start < 0) throw new Error(`no defineDeps for ${regName} in:\n${output}`);
  const from = start + marker.length;
  const end = output.indexOf("]);", from);
  return output.slice(from, end + 1);
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

  test("parameterized (a, b) => IFoo keys on the RETURN type's token", () => {
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
    // The factory ref is keyed on the return type (IFoo), NOT the params.
    expect(depsArrayFor(output, "Svc")).toBe('[[{ type: "./app/IFoo" }]]');
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

  test("Promise<IFoo> return type unwraps to IFoo's token", () => {
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
    // Promise-ness lives in the factory, not the token (PRD §8 line 467).
    expect(depsArrayFor(output, "Svc")).toBe('[[{ type: "./app/IFoo" }]]');
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

  test("a factory whose return type is a primitive produces a hard error", () => {
    // Per design §5: no silent fallback. `() => string` cannot derive a factory token.
    // The param itself has no derivable token → UnderivableToken diagnostic.
    const src = `
      interface ISvc {}
      class Svc implements ISvc {
        constructor(makeName: () => string) {}
      }
      declare const services: any;
      services.add<ISvc>(Svc).as<"singleton">();
    `;
    const { diagnostics } = transform(fixture(src));
    // The makeName param falls through — its resolved type is a function type
    // with no derivable token → hard error.
    expect(
      diagnostics.filter((d) => d.code === DiagnosticCode.UnderivableToken).length,
    ).toBeGreaterThanOrEqual(1);
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
