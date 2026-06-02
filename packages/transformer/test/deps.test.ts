import { test, expect, describe } from "bun:test";
import { transform, fixture } from "./harness.js";
import { DiagnosticCode } from "../src/index.js";

// Dependency extraction → defineDeps emission (PRD §8). The emitted shape is the
// ABI `Token[][]`: an array of signatures, each a positional array of
// tokens / FactoryRef / ScopeRef / Union slots. There is no `null`/hole sentinel;
// unresolvable types produce a hard UnderivableToken diagnostic.

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
  test("primitive parameter types produce hard UnderivableToken diagnostics", () => {
    // Per design §5: no silent fallback. Unresolvable types → hard error.
    const src = `
      interface IMarker {}
      class Prims implements IMarker {
        constructor(
          a: string,
          b: number,
          c: boolean,
        ) {}
      }
      declare const services: any;
      services.add<IMarker>(Prims).as<"singleton">();
    `;
    const { diagnostics } = transform(fixture(src));
    const errCodes = diagnostics
      .filter((d) => d.code === DiagnosticCode.UnderivableToken)
      .map((d) => d.code);
    // Each unresolvable param produces one diagnostic.
    expect(errCodes.length).toBe(3);
    expect(diagnostics.find((d) => d.code === DiagnosticCode.UnderivableToken)!.category).toBe(
      1 /* ts.DiagnosticCategory.Error */,
    );
  });

  test("any / unknown / void also produce UnderivableToken diagnostics", () => {
    const src = `
      interface IMarker {}
      class Tops implements IMarker {
        constructor(a: any, b: unknown, c: void) {}
      }
      declare const services: any;
      services.add<IMarker>(Tops).as<"singleton">();
    `;
    const { diagnostics } = transform(fixture(src));
    expect(
      diagnostics.filter((d) => d.code === DiagnosticCode.UnderivableToken).length,
    ).toBe(3);
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

  test("mixed multi-param ctor: tokens for resolvable params, error for unresolvable", () => {
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
    const { diagnostics } = transform(fixture(src));
    // The `string` param produces a hard error.
    expect(
      diagnostics.filter((d) => d.code === DiagnosticCode.UnderivableToken).length,
    ).toBe(1);
  });

  test("class is registered, emits exactly one signature (array-of-one)", () => {
    const src = `
      interface IFoo {}
      class Foo implements IFoo { constructor() {} }
      declare const services: any;
      services.add<IFoo>(Foo).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    const arr = depsArrayFor(output, "Foo");
    // Outer array has exactly one element (one signature), empty (no params).
    expect(arr).toBe("[[]]");
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
