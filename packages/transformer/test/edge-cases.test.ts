import { test, expect, describe } from "bun:test";
import { transform, fixture } from "./harness.js";

// Basic edge-case behaviour (PRD §8) — NOT the Phase-2D factory diagnostic.

describe("statically-resolved classes always carry an inline signature", () => {
  // The transformer is now the sole signature channel — the global metadata
  // store and the `forCtor` annotation/`AlreadyAnnotated` skip are retired. A
  // statically-resolved class always gets its signature inline on the add call.
  test("a class emits its signature inline as the third add argument", () => {
    const src = `
      interface IFoo {}
      class Foo implements IFoo { constructor() {} }
      declare const services: any;
      services.add<IFoo>(Foo).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    expect(output).toContain('services.add("./app:IFoo", Foo, [[]]).as("singleton")');
    expect(output).not.toContain("defineDeps");
  });
});

describe("fully-dynamic classes", () => {
  test("concrete passed via a variable → no dep array emitted, no defineDeps", () => {
    const src = `
      interface IFoo {}
      class Foo implements IFoo { constructor(x: string) {} }
      declare const services: any;
      const Ctor: any = Foo;
      services.add<IFoo>(Ctor).as<"singleton">();
    `;
    const { output } = transform(fixture(src));

    // No defineDeps for a dynamically-referenced ctor (the runtime throws with
    // guidance at resolve time — that is @fnioc/di's job).
    expect(output).not.toContain("defineDeps(");
    // The registration is still lowered to the string-token form.
    expect(output).toContain('services.add("./app:IFoo", Ctor).as("singleton")');
  });

  test("concrete that is a call expression → no dep array", () => {
    const src = `
      interface IFoo {}
      declare function makeCtor(): any;
      declare const services: any;
      services.add<IFoo>(makeCtor()).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    expect(output).not.toContain("defineDeps(");
    expect(output).toContain('services.add("./app:IFoo", makeCtor()).as("singleton")');
  });
});
