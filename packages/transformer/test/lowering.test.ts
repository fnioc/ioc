import { test, expect, describe } from "bun:test";
import { transform, fixture, ROOT } from "./harness.js";

// Registration lowering (PRD §8): `add<I>(C).as<"x">()` → string-token form,
// carrying the derived dep signature INLINE as the registration call's third
// argument (`add("token", C, [[...]])`). The global metadata store is retired —
// no hoisted const, no `defineDeps(...)` prelude, no injected import.

describe("registration lowering", () => {
  test("lowers add<I>(C).as<\"x\">() to the string-token form", () => {
    const src = `
      interface ILogger {}
      interface IDbConnection {}
      interface IUserRepo {}
      class SqlUserRepo implements IUserRepo {
        constructor(log: ILogger, db: IDbConnection) {}
      }
      declare const services: any;
      services.add<IUserRepo>(SqlUserRepo).as<"request">();
    `;
    const { output } = transform(fixture(src));

    // The signature rides inline as the third argument; no hoist, no defineDeps.
    expect(output).toContain(
      'services.add("./app/IUserRepo", SqlUserRepo, [["./app/ILogger", "./app/IDbConnection"]]).as("request")',
    );
    expect(output).not.toContain("ɵreg");
    expect(output).not.toContain("defineDeps");
  });

  test("emits an empty signature for a zero-arg constructor", () => {
    const src = `
      interface ILogger {}
      class ConsoleLogger implements ILogger {}
      declare const services: any;
      services.add<ILogger>(ConsoleLogger).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    expect(output).toContain(
      'services.add("./app/ILogger", ConsoleLogger, [[]]).as("singleton")',
    );
    expect(output).not.toContain("defineDeps");
  });

  test("no @fnioc/di import is injected (signatures ride inline)", () => {
    const src = `
      interface IFoo {}
      class Foo implements IFoo { constructor() {} }
      declare const services: any;
      services.add<IFoo>(Foo).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    expect(output).not.toContain("defineDeps");
    expect(output).not.toContain('from "@fnioc/di"');
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
    expect(output).toContain('services.add("./app/IFoo", Foo, [[]])');
    expect(output).not.toContain("defineDeps");
  });
});

void ROOT;
