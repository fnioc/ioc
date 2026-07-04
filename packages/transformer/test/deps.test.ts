import { test, expect, describe } from "bun:test";
import { transform, fixture } from "./harness.js";
import { DiagnosticCode } from "../src/index.js";

// Dependency extraction → defineDeps emission (PRD §8). The emitted shape is the
// ABI `Token[][]`: an array of signatures, each a positional array of
// tokens / FactoryRef / ScopeRef / Union / LiteralRef slots. There is no
// `null`/hole sentinel. Under Rule 1 EVERY named type tokenizes by its name —
// intrinsics (`string`, `number`, `boolean`, `any`, `unknown`, `void`, …) become
// their keyword as a token; an unregistered token simply misses at runtime, it is
// NOT a compile error. ONLY an anonymous inline structure (a `__type`/nameless
// non-intrinsic) still produces the hard UnderivableToken diagnostic.

/**
 * Pull the `[[...]]` signature array text out of the inline registration call
 * for the given class/factory. Signatures now ride ON the registration as the
 * third argument: `add("token", Ctor, [[...]])` / `addFactory("token", fn,
 * [[...]])`. We locate the `, ${ctor}, ` boundary and balanced-scan the `[[...]]`.
 */
function depsArrayFor(output: string, ctor: string): string {
  const marker = `, ${ctor}, `;
  const at = output.indexOf(marker);
  if (at < 0) {throw new Error(`no inline signature for ${ctor} in:\n${output}`);}
  const start = output.indexOf("[", at + marker.length);
  if (start < 0) {throw new Error(`no signature array for ${ctor} in:\n${output}`);}
  let depth = 0;
  for (let i = start; i < output.length; i++) {
    const ch = output[i];
    if (ch === "[") {
      depth += 1;
    } else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {return output.slice(start, i + 1);}
    }
  }
  throw new Error(`unbalanced signature array for ${ctor} in:\n${output}`);
}

describe("dependency extraction", () => {
  test("primitive parameter types tokenize by their keyword (Rule 1, no diagnostics)", () => {
    // Rule 1: every named type — including the intrinsics — tokenizes by its
    // name. `string`/`number`/`boolean` are NOT a compile error; they become the
    // bare tokens "string"/"number"/"boolean" and simply miss at runtime when
    // unregistered.
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
    const { output, diagnostics } = transform(fixture(src));
    expect(
      diagnostics.filter((d) => d.code === DiagnosticCode.UnderivableToken).length,
    ).toBe(0);
    expect(depsArrayFor(output, "Prims")).toBe('[["string", "number", "boolean"]]');
  });

  test("any / unknown tokenize (Rule 1); void supplies undefined (Rule 2)", () => {
    // any / unknown tokenize by keyword. `void` is a singleton type (one
    // inhabitant), so it supplies `undefined` directly as a LiteralRef — NOT a
    // token. `void` is not `| undefined` (no Undefined flag), so it is not an
    // optional param: no overload drop, a single signature.
    const src = `
      interface IMarker {}
      class Tops implements IMarker {
        constructor(a: any, b: unknown, c: void) {}
      }
      declare const services: any;
      services.add<IMarker>(Tops).as<"singleton">();
    `;
    const { output, diagnostics } = transform(fixture(src));
    expect(
      diagnostics.filter((d) => d.code === DiagnosticCode.UnderivableToken).length,
    ).toBe(0);
    expect(depsArrayFor(output, "Tops")).toBe(
      '[["any", "unknown", { value: void 0 }]]',
    );
  });

  test("whole-type undefined / null params supply their value (Rule 2)", () => {
    const src = `
      interface IMarker {}
      class Nullish implements IMarker {
        constructor(a: undefined, b: null) {}
      }
      declare const services: any;
      services.add<IMarker>(Nullish).as<"singleton">();
    `;
    const { output, diagnostics } = transform(fixture(src));
    expect(
      diagnostics.filter((d) => d.code === DiagnosticCode.UnderivableToken).length,
    ).toBe(0);
    // `a: undefined` is a trailing-from-the-left optional? No — `b: null` is not
    // optional (null ≠ undefined), so `a: undefined` is interior. An interior
    // whole-type `undefined` is still a singleton LiteralRef (Rule 2), and `b:
    // null` supplies null. Neither earns an overload drop (b is required).
    expect(depsArrayFor(output, "Nullish")).toBe(
      '[[{ value: void 0 }, { value: null }]]',
    );
  });

  test("anonymous inline structure STILL hard-errors (Rule 1 exception)", () => {
    // The ONLY remaining UnderivableToken case: an anonymous structural type with
    // no name (a `__type` symbol). It has no token, so it is a hard error.
    const src = `
      interface IMarker {}
      class Anon implements IMarker {
        constructor(a: { x: number }) {}
      }
      declare const services: any;
      services.add<IMarker>(Anon).as<"singleton">();
    `;
    const { diagnostics } = transform(fixture(src));
    const errs = diagnostics.filter((d) => d.code === DiagnosticCode.UnderivableToken);
    expect(errs.length).toBe(1);
    expect(errs[0]!.category).toBe(1 /* ts.DiagnosticCategory.Error */);
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
    expect(depsArrayFor(output, "Svc")).toBe('[["./app:ILogger", "./app:IDb"]]');
  });

  test("mixed multi-param ctor: every param tokenizes, including the `string` (Rule 1)", () => {
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
    const { output, diagnostics } = transform(fixture(src));
    // The `string` param no longer errors — it tokenizes to the bare "string".
    expect(
      diagnostics.filter((d) => d.code === DiagnosticCode.UnderivableToken).length,
    ).toBe(0);
    expect(depsArrayFor(output, "SqlUserRepo")).toBe(
      '[["./app:ILogger", "./app:IDbConnection", "string"]]',
    );
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
    expect(depsArrayFor(output, "Svc")).toBe('[["./app:Logger"]]');
  });
});
