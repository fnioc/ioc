import { test, expect, describe } from "bun:test";
import { transform, type VirtualFiles } from "./harness.js";

// Token generation (PRD §8). Tokens are exercised through the lowered output:
//   - package-public type  →  `packageName:subpath/Symbol`  (version excluded)
//   - app-internal type    →  source-relative `./...` token
//   - `Promise<X>`         →  the token for `X`

// A library installed under node_modules with an `exports` subpath map.
function withLib(appSource: string): VirtualFiles {
  return {
    "/proj/node_modules/your-lib/package.json": JSON.stringify({
      name: "your-lib",
      version: "3.4.5",
      exports: {
        ".": "./index.js",
        "./contracts": "./contracts/index.js",
      },
    }),
    "/proj/node_modules/your-lib/index.d.ts": `
      export interface IRoot {}
    `,
    "/proj/node_modules/your-lib/contracts/index.d.ts": `
      export interface IFoo {}
      export interface IBar {}
    `,
    "/proj/src/app.ts": appSource,
  };
}

describe("token generation", () => {
  test("package-public type → packageName:subpath/Symbol", () => {
    const files = withLib(`
      import { IFoo } from "your-lib/contracts";
      class Foo implements IFoo { constructor() {} }
      declare const services: any;
      services.add<IFoo>(Foo).as<"singleton">();
    `);
    const { outputs } = transform(files, { entry: ["/proj/src/app.ts"] });
    const out = outputs["/proj/src/app.ts"]!;
    expect(out).toContain('services.add("your-lib:contracts/IFoo", Foo)');
  });

  test("package-public root export → packageName:Symbol (no subpath)", () => {
    const files = withLib(`
      import { IRoot } from "your-lib";
      class RootImpl implements IRoot { constructor() {} }
      declare const services: any;
      services.add<IRoot>(RootImpl).as<"singleton">();
    `);
    const { outputs } = transform(files, { entry: ["/proj/src/app.ts"] });
    const out = outputs["/proj/src/app.ts"]!;
    expect(out).toContain('services.add("your-lib:IRoot", RootImpl)');
  });

  test("token excludes the package version", () => {
    const files = withLib(`
      import { IFoo } from "your-lib/contracts";
      class Foo implements IFoo { constructor() {} }
      declare const services: any;
      services.add<IFoo>(Foo).as<"singleton">();
    `);
    const { outputs } = transform(files, { entry: ["/proj/src/app.ts"] });
    const out = outputs["/proj/src/app.ts"]!;
    expect(out).not.toContain("3.4.5");
    expect(out).toContain("your-lib:contracts/IFoo");
  });

  test("app-internal (non-exported) type → source-relative token", () => {
    // No package.json provides this interface's file as a public export, and the
    // interface lives in the app's own src tree → a `./...` token.
    const files: VirtualFiles = {
      "/proj/package.json": JSON.stringify({ name: "the-app", version: "1.0.0" }),
      "/proj/src/services/IUserRepo.ts": `export interface IUserRepo {}`,
      "/proj/src/app.ts": `
        import { IUserRepo } from "./services/IUserRepo";
        class SqlUserRepo implements IUserRepo { constructor() {} }
        declare const services: any;
        services.add<IUserRepo>(SqlUserRepo).as<"request">();
      `,
    };
    const { outputs } = transform(files, {
      entry: ["/proj/src/app.ts"],
      compilerOptions: { rootDir: "/proj" },
    });
    const out = outputs["/proj/src/app.ts"]!;
    expect(out).toContain('services.add("./src/services/IUserRepo", SqlUserRepo)');
  });

  test("app-internal token appends Symbol when file basename differs", () => {
    const files: VirtualFiles = {
      "/proj/package.json": JSON.stringify({ name: "the-app", version: "1.0.0" }),
      "/proj/src/contracts.ts": `export interface IThing {}`,
      "/proj/src/app.ts": `
        import { IThing } from "./contracts";
        class Thing implements IThing { constructor() {} }
        declare const services: any;
        services.add<IThing>(Thing).as<"singleton">();
      `,
    };
    const { outputs } = transform(files, {
      entry: ["/proj/src/app.ts"],
      compilerOptions: { rootDir: "/proj" },
    });
    const out = outputs["/proj/src/app.ts"]!;
    expect(out).toContain('services.add("./src/contracts/IThing", Thing)');
  });

  test("Promise<X> parameter → the token for X (Promise stripped)", () => {
    const files = withLib(`
      import { IFoo } from "your-lib/contracts";
      class Foo implements IFoo {}
      class NeedsAsync {
        constructor(foo: Promise<IFoo>) {}
      }
      class Marker {}
      declare const services: any;
      services.add<IFoo>(Foo).as<"singleton">();
      services.add<Marker>(NeedsAsync).as<"singleton">();
    `);
    const { outputs } = transform(files, { entry: ["/proj/src/app.ts"] });
    const out = outputs["/proj/src/app.ts"]!;
    // NeedsAsync's ctor param Promise<IFoo> lowers to the IFoo token, not a
    // Promise token. (The TS type annotation `Promise<IFoo>` still prints in
    // this harness's output, but it carries no token of its own.)
    expect(out).toContain('defineDeps(NeedsAsync, [["your-lib:contracts/IFoo"]])');
    expect(out).not.toContain('"Promise');
    expect(out).not.toContain(":Promise");
  });
});
