import { test, expect, describe } from "bun:test";
import { transform, fixture, type VirtualFiles } from "./harness.js";

// Factory detection (PRD §7 / §8). A constructor parameter whose type ANNOTATION
// is an inline function-type literal (`() => IFoo`) emits a
// `{ factory: "<token-for-the-return-type>" }` slot — the `FactoryRef` ABI shape
// — instead of a plain token. A NAMED function-interface reference is the
// deliberate opt-out and resolves to its own normal token. Detection is purely
// syntactic (the annotation's shape), never the resolved type.

/** Pull the `[[...]]` signature array text out of a defineDeps(...) call. */
function depsArrayFor(output: string, ctor: string): string {
  const marker = `defineDeps(${ctor}, `;
  const start = output.indexOf(marker);
  if (start < 0) throw new Error(`no defineDeps for ${ctor} in:\n${output}`);
  const from = start + marker.length;
  const end = output.indexOf("]);", from);
  return output.slice(from, end + 1);
}

describe("factory detection", () => {
  test("inline () => IFoo emits a { factory: token } slot", () => {
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
    expect(depsArrayFor(output, "Svc")).toBe('[[{ factory: "./app/IFoo" }]]');
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
    expect(depsArrayFor(output, "Svc")).toBe('[[{ factory: "./app/IFoo" }]]');
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
    expect(depsArrayFor(output, "Svc")).toBe('[[{ factory: "./app/IFoo" }]]');
  });

  test("factory mixes with plain tokens and holes in one signature", () => {
    const src = `
      interface ILogger {}
      interface IFoo {}
      interface ISvc {}
      class Svc implements ISvc {
        constructor(log: ILogger, makeFoo: () => IFoo, name: string) {}
      }
      declare const services: any;
      services.add<ISvc>(Svc).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    expect(depsArrayFor(output, "Svc")).toBe(
      '[["./app/ILogger", { factory: "./app/IFoo" }, null]]',
    );
  });

  test("a factory whose return type is a primitive is a plain hole, not a factory", () => {
    const src = `
      interface ISvc {}
      class Svc implements ISvc {
        constructor(makeName: () => string) {}
      }
      declare const services: any;
      services.add<ISvc>(Svc).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    // No derivable token for a primitive return → fall through to a hole.
    expect(depsArrayFor(output, "Svc")).toBe("[[null]]");
    expect(output).not.toContain("factory:");
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
      '[[{ factory: "your-lib:contracts/IFoo" }]]',
    );
  });
});
