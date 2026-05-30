import { test, expect, describe } from "bun:test";
import { transform, fixture, ROOT } from "./harness.js";

// Registration lowering (PRD §8): `add<I>(C).as<"x">()` → string-token form,
// with a `defineDeps(C, [[...]])` prelude inserted before the registration.

describe("registration lowering", () => {
  test("lowers add<I>(C).as<\"x\">() to the string-token form", () => {
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

    // The type arg on add<> is lowered to a string token, prepended before the
    // concrete value arg; the type arg on as<> becomes a value arg.
    expect(output).toContain('services.add("./app/IUserRepo", SqlUserRepo).as("request")');

    // A defineDeps prelude is emitted immediately before the registration, with
    // the ctor params as a single positional signature; `string` → null hole.
    expect(output).toContain(
      'defineDeps(SqlUserRepo, [["./app/ILogger", "./app/IDbConnection", null]])',
    );

    // The prelude precedes the lowered registration.
    const depsIdx = output.indexOf("defineDeps(SqlUserRepo");
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
    expect(output).toContain("defineDeps(ConsoleLogger, [[]])");
    expect(output).toContain('services.add("./app/ILogger", ConsoleLogger).as("singleton")');
  });

  test("injects the @fnioc/core defineDeps import when a registration lowers", () => {
    const src = `
      interface IFoo {}
      class Foo implements IFoo { constructor() {} }
      declare const services: any;
      services.add<IFoo>(Foo).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    // The injected import binds `defineDeps` from @fnioc/core. The standalone
    // printer keeps the generated-name `as` alias (`defineDeps as defineDeps`);
    // the real tsc emitter elides the redundant alias to `{ defineDeps }` (see
    // the ts-patch e2e). Assert the binding regardless of the alias form.
    expect(output).toMatch(
      /import \{ defineDeps( as \w+)? \} from "@fnioc\/core"/,
    );
    // And the emitted call references that same binding.
    expect(output).toContain("defineDeps(Foo, [[]])");
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

  test("lowering is registration-shaped, not any .add call", () => {
    // A `.add` with no type argument is NOT a registration and is left alone.
    const src = `
      declare const set: { add(x: number): void };
      set.add(1);
    `;
    const { output } = transform(fixture(src));
    expect(output).toContain("set.add(1)");
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
    expect(output).toContain('services.add("./app/IFoo", Foo)');
    expect(output).toContain("defineDeps(Foo, [[]])");
  });
});

void ROOT;
