import { test, expect, describe } from "bun:test";
import { transform, fixture } from "./harness.js";

// Dependency extraction → defineDeps emission (PRD §8). The emitted shape is the
// ABI `Token[][]`: an array of signatures, each a positional array of
// `string | null`. Wide primitives (`string`/`number`/`boolean`) produce a bare
// token (e.g. `"string"`) rather than `null`; `null` is reserved for holes
// (`symbol`, `any`, `unknown`, `void`, `bigint`, and annotated-`hole` positions).

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
  // The emitted form is `defineDeps(ɵregN, [[...]]);`. The signature literal
  // `[[...]]` ends just before the call's `)` — i.e. at the first `]` of `]);`.
  const end = output.indexOf("]);", from);
  return output.slice(from, end + 1);
}

describe("dependency extraction", () => {
  test("wide primitives become bare tokens; other scalars remain null", () => {
    // string/number/boolean lower to bare token strings (the new behavior —
    // wide-primitive → bare-token rule). symbol/bigint stay as null holes.
    const src = `
      interface IMarker {}
      class Prims implements IMarker {
        constructor(
          a: string,
          b: number,
          c: boolean,
          d: symbol,
          e: bigint,
        ) {}
      }
      declare const services: any;
      services.add<IMarker>(Prims).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    expect(depsArrayFor(output, "Prims")).toBe('[["string", "number", "boolean", null, null]]');
  });

  test("any / unknown / void map to null too", () => {
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

  test("tokens for interface parameters", () => {
    const src = `
      interface ILogger {}
      interface IDb {}
      interface IMarker {}
      class Svc implements IMarker {
        constructor(log: ILogger, db: IDb) {}
      }
      declare const services: any;
      services.add<IMarker>(Svc).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    expect(depsArrayFor(output, "Svc")).toBe('[["./app/ILogger", "./app/IDb"]]');
  });

  test("mixed multi-param ctor: tokens interleaved with null holes", () => {
    // `table: symbol` is a hole (symbol stays null); ILogger and IDbConnection
    // are interface tokens. Wide primitives (string/number/boolean) are now bare
    // tokens — the hole is demonstrated here using symbol instead.
    const src = `
      interface ILogger {}
      interface IDbConnection {}
      interface IUserRepo {}
      class SqlUserRepo implements IUserRepo {
        constructor(log: ILogger, db: IDbConnection, table: symbol) {}
      }
      declare const services: any;
      services.add<IUserRepo>(SqlUserRepo).as<"request">();
    `;
    const { output } = transform(fixture(src));
    expect(depsArrayFor(output, "SqlUserRepo")).toBe(
      '[["./app/ILogger", "./app/IDbConnection", null]]',
    );
  });

  test("class is registered, emits exactly one signature (array-of-one)", () => {
    // `string` is now a bare token (not a hole), so the emitted slot is "string".
    // A single-signature registration still produces exactly one array element.
    const src = `
      interface IFoo {}
      class Foo implements IFoo { constructor(x: string) {} }
      declare const services: any;
      services.add<IFoo>(Foo).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    const arr = depsArrayFor(output, "Foo");
    // Outer array has exactly one element (one signature).
    expect(arr).toBe('[["string"]]');
  });

  test("non-wide-primitive scalars (symbol, bigint, any) remain null holes", () => {
    const src = `
      interface IMarker {}
      class Tops implements IMarker {
        constructor(a: symbol, b: bigint, c: any) {}
      }
      declare const services: any;
      services.add<IMarker>(Tops).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    expect(depsArrayFor(output, "Tops")).toBe("[[null, null, null]]");
  });

  test("class type parameter resolves to a token (not a hole)", () => {
    // A concrete class (not an interface) used as a ctor param type is still a
    // resolvable token.
    const src = `
      interface IMarker {}
      class Logger {}
      class Svc implements IMarker {
        constructor(log: Logger) {}
      }
      declare const services: any;
      services.add<IMarker>(Svc).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    expect(depsArrayFor(output, "Svc")).toBe('[["./app/Logger"]]');
  });
});
