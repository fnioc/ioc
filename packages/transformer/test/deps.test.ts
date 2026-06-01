import { test, expect, describe } from "bun:test";
import { transform, fixture } from "./harness.js";

// Dependency extraction → defineDeps emission (PRD §8). The emitted shape is the
// ABI `Token[][]`: an array of signatures, each a positional array of
// `string | null` (null = hole for a non-tokenable primitive).

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
  test("null for every primitive parameter type", () => {
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
    expect(depsArrayFor(output, "Prims")).toBe("[[null, null, null, null, null]]");
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
    // Matches the PRD §8 canonical lowered example shape.
    expect(depsArrayFor(output, "SqlUserRepo")).toBe(
      '[["./app/ILogger", "./app/IDbConnection", null]]',
    );
  });

  test("class is registered, emits exactly one signature (array-of-one)", () => {
    const src = `
      interface IFoo {}
      class Foo implements IFoo { constructor(x: string) {} }
      declare const services: any;
      services.add<IFoo>(Foo).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    const arr = depsArrayFor(output, "Foo");
    // Outer array has exactly one element (one signature).
    expect(arr).toBe("[[null]]");
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
