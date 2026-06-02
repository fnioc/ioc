import { test, expect, describe } from "bun:test";
import { transform, fixture, ROOT } from "./harness.js";

// Registration lowering (PRD §8): `add<I>(C).as<"x">()` → string-token form,
// with a hoisted `const ɵregN = C;` + `defineDeps(ɵregN, [[...]])` prelude
// inserted before the registration. The always-hoist invariant ensures metadata
// is keyed on exactly the same object the registration uses.

describe("registration lowering", () => {
  test("lowers add<I>(C).as<\"x\">() to the string-token form", () => {
    // `table: string` now emits the bare token "string" (wide-primitive→bare-token
    // rule). A genuine null hole would require symbol/any/bigint/etc.
    const src = `
      interface ILogger {}
      interface IDbConnection {}
      interface IUserRepo {}
      class SqlUserRepo implements IUserRepo {
        constructor(log: ILogger, db: IDbConnection, table: string) {}
      }
      declare const services: any;
      services.add<IUserRepo>(SqlUserRepo).as<"request">();
    `;
    const { output } = transform(fixture(src));

    // The arg is hoisted; the lowered call references ɵreg0 (not the raw class).
    expect(output).toContain('services.add("./app/IUserRepo", ɵreg0).as("request")');

    // A defineDeps prelude is emitted against the hoisted const, with the ctor
    // params as a single positional signature; `string` → bare token "string".
    expect(output).toContain(
      'defineDeps(ɵreg0, [["./app/ILogger", "./app/IDbConnection", "string"]])',
    );

    // The prelude precedes the lowered registration.
    const depsIdx = output.indexOf("defineDeps(ɵreg0");
    const addIdx = output.indexOf("services.add(");
    expect(depsIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeGreaterThan(depsIdx);
  });

  test("emits an empty signature for a zero-arg constructor", () => {
    const src = `
      interface ILogger {}
      class ConsoleLogger implements ILogger {}
      declare const services: any;
      services.add<ILogger>(ConsoleLogger).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    expect(output).toContain("defineDeps(ɵreg0, [[]])");
    expect(output).toContain('services.add("./app/ILogger", ɵreg0).as("singleton")');
  });

  test("injects the @fnioc/di defineDeps import when a registration lowers", () => {
    const src = `
      interface IFoo {}
      class Foo implements IFoo { constructor() {} }
      declare const services: any;
      services.add<IFoo>(Foo).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    // The injected import binds `defineDeps` from @fnioc/di. The standalone
    // printer keeps the generated-name `as` alias (`defineDeps as defineDeps`);
    // the real tsc emitter elides the redundant alias to `{ defineDeps }` (see
    // the ts-patch e2e). Assert the binding regardless of the alias form.
    expect(output).toMatch(
      /import \{ defineDeps( as \w+)? \} from "@fnioc\/di"/,
    );
    // And the emitted call references the hoisted const.
    expect(output).toContain("defineDeps(ɵreg0, [[]])");
  });

  test("does not double-import defineDeps when already imported", () => {
    const src = `
      import { defineDeps } from "@fnioc/core";
      interface IFoo {}
      class Foo implements IFoo { constructor() {} }
      declare const services: any;
      services.add<IFoo>(Foo).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    const occurrences = output.split('from "@fnioc/core"').length - 1;
    expect(occurrences).toBe(1);
  });

  test("explicit two-arg add(token, val) is passed through untouched", () => {
    // The two-arg explicit-token form has arguments.length === 2 → excluded from
    // the single-arg registration pattern. It must never be re-lowered.
    const src = `
      declare const services: any;
      services.add("my-token", class {});
    `;
    const { output } = transform(fixture(src));
    expect(output).toContain('services.add("my-token"');
    expect(output).not.toContain("defineDeps");
  });

  test("preserves the value arg and works without a trailing .as()", () => {
    const src = `
      interface IFoo {}
      class Foo implements IFoo { constructor() {} }
      declare const services: any;
      services.add<IFoo>(Foo);
    `;
    const { output } = transform(fixture(src));
    expect(output).toContain('services.add("./app/IFoo", ɵreg0)');
    expect(output).toContain("defineDeps(ɵreg0, [[]])");
  });
});

void ROOT;
