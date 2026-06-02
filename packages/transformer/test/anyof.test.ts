import { test, expect, describe } from "bun:test";
import { transform, fixture } from "./harness.js";

// AnyOf slot emission and wide-primitive→bare-token rule (plan §2).
//
// An inline union `A | B` (no alias, no `undefined` member, not purely literals)
// lowers to a `{ anyOf: [...] }` slot. Declaration order is preserved. Wide
// primitives (string/number/boolean) become bare token strings inside the union.

/**
 * Pull the `[[...]]` signature array text out of a defineDeps(...) call for the
 * given class. Mirrors the helper in deps.test.ts.
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

describe("AnyOf slot emission (union lowering)", () => {
  test("basic inline union → { anyOf: [...] } with declaration order preserved", () => {
    const src = `
      interface IFoo {}
      interface IBar {}
      interface IMarker {}
      class Svc implements IMarker {
        constructor(dep: IFoo | IBar) {}
      }
      declare const services: any;
      services.add<IMarker>(Svc).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    // Members preserve declaration order: IFoo first, IBar second.
    expect(depsArrayFor(output, "Svc")).toBe(
      '[[{ anyOf: ["./app/IFoo", "./app/IBar"] }]]',
    );
  });

  test("declaration order preserved (not sorted or reversed)", () => {
    const src = `
      interface IAlpha {}
      interface IBeta {}
      interface IMarker {}
      class Svc implements IMarker {
        constructor(dep: IBeta | IAlpha) {}
      }
      declare const services: any;
      services.add<IMarker>(Svc).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    // IBeta declared first in the union → IBeta first in anyOf.
    expect(depsArrayFor(output, "Svc")).toBe(
      '[[{ anyOf: ["./app/IBeta", "./app/IAlpha"] }]]',
    );
  });

  test("wide primitive string in union → bare token 'string'", () => {
    const src = `
      interface IFoo {}
      interface IMarker {}
      class Svc implements IMarker {
        constructor(dep: string | IFoo) {}
      }
      declare const services: any;
      services.add<IMarker>(Svc).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    expect(depsArrayFor(output, "Svc")).toBe(
      '[[{ anyOf: ["string", "./app/IFoo"] }]]',
    );
  });

  test("wide primitive number in union → bare token 'number'", () => {
    // TypeScript normalizes union member order (primitives may appear first in
    // the internal representation). The test matches TS's actual emission order.
    const src = `
      interface IFoo {}
      interface IMarker {}
      class Svc implements IMarker {
        constructor(dep: number | IFoo) {}
      }
      declare const services: any;
      services.add<IMarker>(Svc).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    expect(depsArrayFor(output, "Svc")).toBe(
      '[[{ anyOf: ["number", "./app/IFoo"] }]]',
    );
  });

  test("wide primitive boolean in union → bare token 'boolean'", () => {
    const src = `
      interface IFoo {}
      interface IMarker {}
      class Svc implements IMarker {
        constructor(dep: boolean | IFoo) {}
      }
      declare const services: any;
      services.add<IMarker>(Svc).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    expect(depsArrayFor(output, "Svc")).toBe(
      '[[{ anyOf: ["boolean", "./app/IFoo"] }]]',
    );
  });

  test("pure literal union is NOT an AnyOf — handled by literalToken path", () => {
    const src = `
      interface IMarker {}
      class Svc implements IMarker {
        constructor(dep: "a" | "b") {}
      }
      declare const services: any;
      services.add<IMarker>(Svc).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    // Pure literal union → sorted-literal token (existing literalToken path).
    // "a" | "b" sorts to '"a" | "b"'.
    expect(depsArrayFor(output, "Svc")).toBe('[["\\"a\\" | \\"b\\""]]');
  });

  test("named/aliased union is NOT an AnyOf — handled by deriveToken via aliasSymbol", () => {
    const src = `
      interface IFoo {}
      interface IBar {}
      type FooOrBar = IFoo | IBar;
      interface IMarker {}
      class Svc implements IMarker {
        constructor(dep: FooOrBar) {}
      }
      declare const services: any;
      services.add<IMarker>(Svc).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    // Named union → single token for the alias FooOrBar (app-internal path).
    expect(depsArrayFor(output, "Svc")).toBe('[["./app/FooOrBar"]]');
  });

  test("undefined member is stripped from union; if one member remains, not an AnyOf", () => {
    // IFoo | undefined → optional param; not an AnyOf. The param earns an
    // optional overload via withOptionalOverloads, IFoo token is the slot.
    const src = `
      interface IFoo {}
      interface IMarker {}
      class Svc implements IMarker {
        constructor(dep?: IFoo) {}
      }
      declare const services: any;
      services.add<IMarker>(Svc).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    // Optional IFoo → two overloads: [IFoo] and [].
    expect(depsArrayFor(output, "Svc")).toBe('[["./app/IFoo"], []]');
  });

  test("undefined member stripped from multi-member union; remaining members form AnyOf", () => {
    // IFoo | IBar | undefined → AnyOf([IFoo, IBar]) + optional overload.
    const src = `
      interface IFoo {}
      interface IBar {}
      interface IMarker {}
      class Svc implements IMarker {
        constructor(dep?: IFoo | IBar) {}
      }
      declare const services: any;
      services.add<IMarker>(Svc).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    // Two overloads: [AnyOf(IFoo, IBar)] and [].
    expect(depsArrayFor(output, "Svc")).toBe(
      '[[{ anyOf: ["./app/IFoo", "./app/IBar"] }], []]',
    );
  });
});

describe("wide-primitive → bare token rule (tokenForType)", () => {
  test("standalone string param → bare token 'string' (not null)", () => {
    const src = `
      interface IMarker {}
      class Svc implements IMarker {
        constructor(s: string) {}
      }
      declare const services: any;
      services.add<IMarker>(Svc).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    expect(depsArrayFor(output, "Svc")).toBe('[["string"]]');
  });

  test("standalone number param → bare token 'number'", () => {
    const src = `
      interface IMarker {}
      class Svc implements IMarker {
        constructor(n: number) {}
      }
      declare const services: any;
      services.add<IMarker>(Svc).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    expect(depsArrayFor(output, "Svc")).toBe('[["number"]]');
  });

  test("standalone boolean param → bare token 'boolean'", () => {
    const src = `
      interface IMarker {}
      class Svc implements IMarker {
        constructor(b: boolean) {}
      }
      declare const services: any;
      services.add<IMarker>(Svc).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    expect(depsArrayFor(output, "Svc")).toBe('[["boolean"]]');
  });

  test("string literal 'hello' is NOT a wide primitive — literalToken path wins", () => {
    const src = `
      interface IMarker {}
      class Svc implements IMarker {
        constructor(mode: "hello") {}
      }
      declare const services: any;
      services.add<IMarker>(Svc).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    // literalToken: JSON.stringify("hello") = '"hello"'
    expect(depsArrayFor(output, "Svc")).toBe('[["\\"hello\\""]]');
  });

  test("boolean literal union true|false is the wide boolean type — bare token 'boolean'", () => {
    // TypeScript represents `true | false` as the wide `boolean` flag at the type
    // level (it IS boolean). `widePrimitiveToken` fires first → bare "boolean" token.
    const src = `
      interface IMarker {}
      class Svc implements IMarker {
        constructor(flag: true | false) {}
      }
      declare const services: any;
      services.add<IMarker>(Svc).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    expect(depsArrayFor(output, "Svc")).toBe('[["boolean"]]');
  });

  test("symbol param stays null (not a wide primitive)", () => {
    const src = `
      interface IMarker {}
      class Svc implements IMarker {
        constructor(key: symbol) {}
      }
      declare const services: any;
      services.add<IMarker>(Svc).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    expect(depsArrayFor(output, "Svc")).toBe("[[null]]");
  });

  test("any / unknown / void stay null", () => {
    const src = `
      interface IMarker {}
      class Tops implements IMarker {
        constructor(a: any, b: unknown, c: void) {}
      }
      declare const services: any;
      services.add<IMarker>(Tops).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    expect(depsArrayFor(output, "Tops")).toBe("[[null, null, null]]");
  });
});
