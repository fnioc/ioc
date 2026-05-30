import { test, expect, describe } from "bun:test";
import { transform, fixture, type VirtualFiles } from "./harness.js";

// `nameof<T>()` rewriting (PRD §8): a `nameof<IFoo>()` call in source is
// replaced by its string token at compile time.

describe("nameof<T>() rewriting", () => {
  test("rewrites nameof<IFoo>() to the app-internal token", () => {
    const src = `
      import { nameof } from "@fnioc/transformer";
      interface IFoo {}
      const key = nameof<IFoo>();
    `;
    const { output } = transform(fixture(src));
    expect(output).toContain('const key = "./app/IFoo"');
    expect(output).not.toContain("nameof<");
  });

  test("rewrites nameof<T>() to a package-public token", () => {
    const files: VirtualFiles = {
      "/proj/node_modules/your-lib/package.json": JSON.stringify({
        name: "your-lib",
        version: "2.0.0",
        exports: { "./contracts": "./contracts/index.js" },
      }),
      "/proj/node_modules/your-lib/contracts/index.d.ts": `export interface IFoo {}`,
      "/proj/src/app.ts": `
        import { nameof } from "@fnioc/transformer";
        import { IFoo } from "your-lib/contracts";
        const key = nameof<IFoo>();
      `,
    };
    const { outputs } = transform(files, { entry: ["/proj/src/app.ts"] });
    const out = outputs["/proj/src/app.ts"]!;
    expect(out).toContain('const key = "your-lib:contracts/IFoo"');
  });

  test("rewrites nameof regardless of how it's imported/aliased", () => {
    // A virtual `@fnioc/transformer` module that genuinely declares `nameof`,
    // so symbol resolution sees the real `nameof` name behind the local alias.
    const files: VirtualFiles = {
      "/proj/node_modules/@fnioc/transformer/package.json": JSON.stringify({
        name: "@fnioc/transformer",
        version: "0.0.0",
        exports: { ".": "./index.js" },
      }),
      "/proj/node_modules/@fnioc/transformer/index.d.ts": `export declare function nameof<T>(): string;`,
      "/proj/src/app.ts": `
        import { nameof as keyOf } from "@fnioc/transformer";
        interface IBar {}
        const k = keyOf<IBar>();
      `,
    };
    const { outputs } = transform(files, {
      entry: ["/proj/src/app.ts"],
      compilerOptions: { rootDir: "/proj" },
    });
    const out = outputs["/proj/src/app.ts"]!;
    // The aliased call uses the local name; the rewrite keys on the resolved
    // symbol's real name (`nameof`), so it still lowers to the token.
    expect(out).toContain('const k = "./src/app/IBar"');
  });
});
