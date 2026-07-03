import { test, expect, describe } from "bun:test";
import { transform, fixture } from "./harness.js";

// Per-scope `add${ProperCase<K>}` lowering. A `b.addRequest(C)` authored call is
// the per-scope twin of `b.add<I>(C).as("request")`: same token minting + inline
// signature (the third argument), with the scope (recovered uncapitalize-first
// from the method-name suffix) appended as `.as("request")`. The factory form
// routes to `addFactory(...).as("request")` exactly as `add<I>(fn)` routes to it.

describe("per-scope authored class form", () => {
  test('addRequest(C) → add("token", C, [[...]]).as("request")', () => {
    const src = `
      interface ILogger {}
      interface IDbConnection {}
      interface IUserRepo {}
      class SqlUserRepo implements IUserRepo {
        constructor(log: ILogger, db: IDbConnection) {}
      }
      declare const services: any;
      services.addRequest<IUserRepo>(SqlUserRepo);
    `;
    const { output } = transform(fixture(src));

    // Lowered to the three-arg add(...) with a trailing .as("request").
    expect(output).toContain(
      'services.add("./app/IUserRepo", SqlUserRepo, [["./app/ILogger", "./app/IDbConnection"]]).as("request")',
    );
    expect(output).not.toContain("defineDeps");
  });

  test("addSingleton(C) with a zero-arg ctor emits an empty signature", () => {
    const src = `
      interface ILogger {}
      class ConsoleLogger implements ILogger {}
      declare const services: any;
      services.addSingleton<ILogger>(ConsoleLogger);
    `;
    const { output } = transform(fixture(src));
    expect(output).toContain(
      'services.add("./app/ILogger", ConsoleLogger, [[]]).as("singleton")',
    );
    expect(output).not.toContain("defineDeps");
  });

  test("a no-type-arg addRequest(C) derives the token from the class itself", () => {
    const src = `
      interface IFoo {}
      class Foo implements IFoo { constructor() {} }
      declare const services: any;
      services.addRequest(Foo);
    `;
    const { output } = transform(fixture(src));
    // The instance type Foo drives the token (no explicit <I>).
    expect(output).toContain('services.add("./app/Foo", Foo, [[]]).as("request")');
    expect(output).not.toContain("defineDeps");
  });
});

describe("per-scope authored factory form", () => {
  test('addRequest(fn) → addFactory("token", fn, [[...]]).as("request")', () => {
    const src = `
      interface IClock {}
      declare const services: any;
      services.addRequest<IClock>(() => ({}) as IClock);
    `;
    const { output } = transform(fixture(src));
    // A function arg routes to addFactory (the transformer knows it is callable),
    // then the baked-in scope is appended.
    expect(output).toContain('.addFactory("./app/IClock", ');
    expect(output).toContain('[[]]).as("request")');
  });

  test("an inline factory with deps emits its param signature + .as(scope)", () => {
    // No type arg: the token is the factory's RETURN type. The factory's own
    // params become a plain signature (identical to the add<I>(fn) path).
    const src = `
      interface ILogger {}
      interface IReport {}
      class Report implements IReport {
        constructor(log: ILogger) {}
      }
      declare const services: any;
      services.addRequest((log: ILogger): IReport => new Report(log));
    `;
    const { output } = transform(fixture(src));
    expect(output).toContain('.addFactory("./app/IReport", ');
    expect(output).toContain('[["./app/ILogger"]]).as("request")');
  });
});

describe("per-scope two-arg runtime form passes through", () => {
  test('addRequest("token", C) is left untouched (already the runtime form)', () => {
    const src = `
      declare const services: any;
      services.addRequest("my:token", class {});
    `;
    const { output } = transform(fixture(src));
    // Two-arg form → not the single-arg authoring shape → no rewrite, no .as, no deps.
    expect(output).toContain('services.addRequest("my:token"');
    expect(output).not.toContain("defineDeps");
    expect(output).not.toContain(".as(");
  });

  test("addFactory / addValue are NOT treated as per-scope methods", () => {
    const src = `
      interface IFoo {}
      class Foo implements IFoo {}
      declare const services: any;
      services.addValue<IFoo>(new Foo());
      services.addFactory("t", () => 1);
    `;
    const { output } = transform(fixture(src));
    // addValue lowers to its token form; addFactory two-arg passes through.
    expect(output).toContain('services.addValue("./app/IFoo"');
    expect(output).toContain('services.addFactory("t"');
    // Neither gains a bogus .as() from per-scope handling.
    expect(output).not.toContain('addValue("./app/IFoo", new Foo()).as');
  });
});
