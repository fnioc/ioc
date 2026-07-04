import { test, expect, describe } from "bun:test";
import { transform, fixture, type VirtualFiles } from "./harness.js";
import { DiagnosticCode } from "../src/index.js";

// Open generics (spec v1): closed-generic token derivation (`base<arg1,arg2>`),
// hole placeholders (`$N` via the `Hole<N, C>` brand), instantiation-expression
// lowering with registration-carried dep signatures, the `Typeof<T>`
// witness, and the four new diagnostics (990007–990010).
//
// The `Hole` / `Typeof` brands are declared inline in the fixtures with
// the exact shape @fnioc/core publishes — detection is structural (the `HOLE`
// computed-property brand) / by alias name (`Typeof`), so the local
// declarations exercise the same code paths as the real imports.

const BRANDS = `
  declare const HOLE: unique symbol;
  type Hole<N extends number, C = unknown> = C & { readonly [HOLE]?: N };
  type $<N extends number> = Hole<N>;
  declare const ARG: unique symbol;
  type Typeof<T> = string & { readonly [ARG]?: T };
`;

function codes(diags: readonly { code: number }[]): number[] {
  return diags.map((d) => d.code);
}

describe("closed-generic token derivation", () => {
  test("closed generic reference → base<arg> (app-internal base + arg)", () => {
    const src = `
      interface User {}
      interface IRepo<T> {}
      class UserRepo implements IRepo<User> { constructor() {} }
      declare const services: any;
      services.add<IRepo<User>>(UserRepo).as<"singleton">();
    `;
    const { output, diagnostics } = transform(fixture(src));
    expect(codes(diagnostics)).toEqual([]);
    expect(output).toContain(
      'services.add("./app:IRepo<./app:User>", UserRepo, [[]]).as("singleton");',
    );
    // Signatures ride inline on the registration — no hoist, no defineDeps.
    expect(output).not.toContain("ɵreg");
    expect(output).not.toContain("defineDeps");
  });

  test("package-public type arg → base<importSpecifier:Symbol>", () => {
    const files: VirtualFiles = {
      "/proj/node_modules/your-lib/package.json": JSON.stringify({
        name: "your-lib",
        version: "3.4.5",
        exports: { ".": "./index.js", "./contracts": "./contracts/index.js" },
      }),
      "/proj/node_modules/your-lib/contracts/index.d.ts": `
        export interface IFoo {}
      `,
      "/proj/src/app.ts": `
        import { IFoo } from "your-lib/contracts";
        interface IWrap<T> {}
        class Wrap implements IWrap<IFoo> { constructor() {} }
        declare const services: any;
        services.add<IWrap<IFoo>>(Wrap).as<"singleton">();
      `,
    };
    const { outputs, diagnostics } = transform(files, {
      entry: ["/proj/src/app.ts"],
      compilerOptions: { rootDir: "/proj" },
    });
    expect(codes(diagnostics)).toEqual([]);
    expect(outputs["/proj/src/app.ts"]!).toContain(
      'services.add("./src/app:IWrap<your-lib/contracts:IFoo>", Wrap, ',
    );
  });

  test("nested generic args recurse: IRepo<IBox<User>>", () => {
    const src = `
      interface User {}
      interface IBox<T> {}
      interface IRepo<T> {}
      declare function nameof<T>(): string;
      const t = nameof<IRepo<IBox<User>>>();
    `;
    const { output } = transform(fixture(src));
    expect(output).toContain('"./app:IRepo<./app:IBox<./app:User>>"');
  });

  test("type-parameter defaults arrive fully applied: bare IFoo<T = string>", () => {
    const src = `
      interface ICfg<T = string> {}
      declare function nameof<T>(): string;
      const t = nameof<ICfg>();
    `;
    const { output } = transform(fixture(src));
    expect(output).toContain('"./app:ICfg<string>"');
  });

  test("alias-wins regression: a named alias of a closed generic stays the bare alias token", () => {
    const src = `
      interface User {}
      interface IRepository<T> {}
      type UserRepoAlias = IRepository<User>;
      class SqlUserRepo implements IRepository<User> { constructor() {} }
      declare const services: any;
      services.add<UserRepoAlias>(SqlUserRepo).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    expect(output).toContain('services.add("./app:UserRepoAlias", SqlUserRepo, ');
    expect(output).not.toContain("UserRepoAlias<");
  });

  test("generic alias APPLIED recurses through the alias name: Wrap<User>", () => {
    const src = `
      interface User {}
      interface IBox<T> {}
      type Wrap<T> = IBox<T>;
      declare function nameof<T>(): string;
      const t = nameof<Wrap<User>>();
    `;
    const { output } = transform(fixture(src));
    expect(output).toContain('"./app:Wrap<./app:User>"');
  });

  test("Promise<X> ctor param → the honest closed-generic token Promise<X>", () => {
    const src = `
      interface User {}
      interface IRepo<T> {}
      class Svc {
        constructor(repo: Promise<IRepo<User>>) {}
      }
      declare const services: any;
      services.add(Svc).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    // Honest token-split: Promise<IRepo<User>> is NOT stripped — it derives the
    // closed-generic token `Promise<./app:IRepo<./app:User>>`.
    expect(output).toContain(
      'Svc, [["Promise<./app:IRepo<./app:User>>"]]',
    );
  });

  test("Promise applied INSIDE a type arg does not unwrap — default-lib bare name", () => {
    const src = `
      interface User {}
      interface IRepo<T> {}
      declare function nameof<T>(): string;
      const t = nameof<IRepo<Promise<User>>>();
    `;
    const { output } = transform(fixture(src));
    expect(output).toContain('"./app:IRepo<Promise<./app:User>>"');
  });

  test("default-lib generics tokenize by bare symbol name: Map<string, User>", () => {
    const src = `
      interface User {}
      declare function nameof<T>(): string;
      const t = nameof<Map<string, User>>();
    `;
    const { output } = transform(fixture(src));
    expect(output).toContain('"Map<string,./app:User>"');
  });
});

describe("hole derivation ($N via the Hole brand)", () => {
  test("$<1> / $<2> / $<9> sugar aliases derive $N", () => {
    const src = `
      ${BRANDS}
      interface IPair<A, B> {}
      interface IRepo<T> {}
      declare function nameof<T>(): string;
      const a = nameof<IRepo<$<1>>>();
      const b = nameof<IPair<$<2>, $<9>>>();
    `;
    const { output, diagnostics } = transform(fixture(src));
    expect(codes(diagnostics)).toEqual([]);
    expect(output).toContain('"./app:IRepo<$1>"');
    expect(output).toContain('"./app:IPair<$2,$9>"');
  });

  test("unbounded $<N> sugar derives the $N hole token identically to Hole<N>", () => {
    // Hole detection is brand-based (the HOLE brand), NOT alias-name-based, so
    // the collapsed generic sugar `$<N>` = `Hole<N>` derives the same token.
    const src = `
      ${BRANDS}
      interface IRepo<T> {}
      declare function nameof<T>(): string;
      const a = nameof<IRepo<$<1>>>();
      const b = nameof<IRepo<Hole<1>>>();
    `;
    const { output, diagnostics } = transform(fixture(src));
    expect(codes(diagnostics)).toEqual([]);
    expect(output).toContain('const a = "./app:IRepo<$1>";');
    expect(output).toContain('const b = "./app:IRepo<$1>";');
  });

  test("constrained Hole<N, C> derives $N, not the constraint or an alias token", () => {
    const src = `
      ${BRANDS}
      interface Entity {}
      interface IRepo<T extends Entity> {}
      type H2 = Hole<2, Entity>;
      declare function nameof<T>(): string;
      const a = nameof<IRepo<Hole<1, Entity>>>();
      const b = nameof<IRepo<H2>>();
    `;
    const { output, diagnostics } = transform(fixture(src));
    expect(codes(diagnostics)).toEqual([]);
    expect(output).toContain('const a = "./app:IRepo<$1>";');
    expect(output).toContain('const b = "./app:IRepo<$2>";');
    expect(output).not.toContain('"./app:H2"');
  });
});

describe("instantiation-expression lowering (registration-carried deps)", () => {
  test("open template: add<IRepo<$<1>>>(SqlRepo<$<1>>) — signatures as third arg, no hoist, no defineDeps", () => {
    const src = `
      ${BRANDS}
      interface IDb {}
      interface IRepo<T> {}
      class SqlRepo<T> implements IRepo<T> {
        constructor(db: IDb, seed: T) {}
      }
      declare const services: any;
      services.add<IRepo<$<1>>>(SqlRepo<$<1>>).as<"singleton">();
    `;
    const { output, diagnostics } = transform(fixture(src));
    expect(codes(diagnostics)).toEqual([]);
    expect(output).toContain(
      'services.add("./app:IRepo<$1>", SqlRepo, [["./app:IDb", "$1"]]).as("singleton");',
    );
    // Registration-carried deps: no ctor-keyed metadata, no hoisted const.
    expect(output).not.toContain("defineDeps");
    expect(output).not.toContain("ɵreg");
  });

  test("inverted hole order: add<IPair<$<1>,$<2>>>(Pair<$<2>,$<1>>) maps params through the instantiation", () => {
    const src = `
      ${BRANDS}
      interface IPair<A, B> {}
      class Pair<A, B> implements IPair<B, A> {
        constructor(a: A, b: B) {}
      }
      declare const services: any;
      services.add<IPair<$<1>, $<2>>>(Pair<$<2>, $<1>>).as<"singleton">();
    `;
    const { output, diagnostics } = transform(fixture(src));
    expect(codes(diagnostics)).toEqual([]);
    expect(output).toContain(
      'services.add("./app:IPair<$1,$2>", Pair, [["$2", "$1"]]).as("singleton");',
    );
  });

  test("repeated holes: add<IPair<$<1>,$<1>>>(Pair<$<1>,$<1>>)", () => {
    const src = `
      ${BRANDS}
      interface IPair<A, B> {}
      class Pair<A, B> implements IPair<A, B> {
        constructor(a: A, b: B) {}
      }
      declare const services: any;
      services.add<IPair<$<1>, $<1>>>(Pair<$<1>, $<1>>).as<"singleton">();
    `;
    const { output, diagnostics } = transform(fixture(src));
    expect(codes(diagnostics)).toEqual([]);
    expect(output).toContain(
      'services.add("./app:IPair<$1,$1>", Pair, [["$1", "$1"]]).as("singleton");',
    );
  });

  test("nested instantiation arg: Foo<Pair<$<1>,$<1>>> surfaces the nested template in the dep", () => {
    const src = `
      ${BRANDS}
      interface Pair<A, B> {}
      interface IFoo<T> {}
      class Foo<T> implements IFoo<T> {
        constructor(x: T) {}
      }
      declare const services: any;
      services.add<IFoo<$<1>>>(Foo<Pair<$<1>, $<1>>>).as<"singleton">();
    `;
    const { output, diagnostics } = transform(fixture(src));
    expect(codes(diagnostics)).toEqual([]);
    expect(output).toContain(
      'services.add("./app:IFoo<$1>", Foo, [["./app:Pair<$1,$1>"]]).as("singleton");',
    );
  });

  test("instantiation override where the substituted union COLLAPSES (T | Bar with T = Bar) derives the collapsed type, no false diagnostic", () => {
    const src = `
      ${BRANDS}
      class Bar {}
      interface IRepo<T> {}
      class Repo<T> implements IRepo<T> {
        constructor(x: T | Bar) {}
      }
      declare const services: any;
      services.add<IRepo<Bar>>(Repo<Bar>).as<"singleton">();
    `;
    const { output, diagnostics } = transform(fixture(src));
    expect(codes(diagnostics)).toEqual([]);
    // `T | Bar` with `T = Bar` collapses to the non-union `Bar` — the param is a
    // single `Bar` token, NOT a union deriving the unsubstituted `T`.
    expect(output).toContain(
      'services.add("./app:IRepo<./app:Bar>", Repo, [["./app:Bar"]]).as("singleton");',
    );
  });

  test("closed instantiation: add<IRepo<User>>(SqlRepo<User>) — concrete tokens, still registration-carried", () => {
    const src = `
      ${BRANDS}
      interface User {}
      interface IDb {}
      interface IRepo<T> {}
      class SqlRepo<T> implements IRepo<T> {
        constructor(db: IDb, seed: T) {}
      }
      declare const services: any;
      services.add<IRepo<User>>(SqlRepo<User>).as<"singleton">();
    `;
    const { output, diagnostics } = transform(fixture(src));
    expect(codes(diagnostics)).toEqual([]);
    expect(output).toContain(
      'services.add("./app:IRepo<./app:User>", SqlRepo, [["./app:IDb", "./app:User"]]).as("singleton");',
    );
    expect(output).not.toContain("defineDeps");
  });

  test("per-scope authoring form threads through: addRequest(SqlRepo<$<1>>) with an explicit template token", () => {
    const src = `
      ${BRANDS}
      interface IRepo<T> {}
      class SqlRepo<T> implements IRepo<T> {
        constructor(seed: T) {}
      }
      declare const services: any;
      services.addRequest<IRepo<$<1>>>(SqlRepo<$<1>>);
    `;
    const { output, diagnostics } = transform(fixture(src));
    expect(codes(diagnostics)).toEqual([]);
    expect(output).toContain(
      'services.add("./app:IRepo<$1>", SqlRepo, [["$1"]]).as("request");',
    );
  });
});

describe("Typeof witness", () => {
  test("open binding: Typeof<T> with T = hole → { typeArg: N } slot", () => {
    const src = `
      ${BRANDS}
      interface ILogger<T> {}
      class Logger<T> implements ILogger<T> {
        constructor(category: Typeof<T>) {}
      }
      declare const services: any;
      services.add<ILogger<$<1>>>(Logger<$<1>>).as<"singleton">();
    `;
    const { output, diagnostics } = transform(fixture(src));
    expect(codes(diagnostics)).toEqual([]);
    expect(output).toContain(
      'services.add("./app:ILogger<$1>", Logger, [[{ typeArg: 1 }]]).as("singleton");',
    );
  });

  test("closed binding: Typeof<T> with T concrete → literal value slot with the derived token", () => {
    const src = `
      ${BRANDS}
      interface User {}
      interface ILogger<T> {}
      class Logger<T> implements ILogger<T> {
        constructor(category: Typeof<T>) {}
      }
      declare const services: any;
      services.add<ILogger<User>>(Logger<User>).as<"singleton">();
    `;
    const { output, diagnostics } = transform(fixture(src));
    expect(codes(diagnostics)).toEqual([]);
    expect(output).toContain(
      'services.add("./app:ILogger<./app:User>", Logger, [[{ value: "./app:User" }]]).as("singleton");',
    );
  });
});

describe("resolve / nameof pick up generic tokens automatically", () => {
  test("resolve<IRepo<User>>() lowers to the closed token", () => {
    const src = `
      interface User {}
      interface IRepo<T> {}
      declare const provider: any;
      const r = provider.resolve<IRepo<User>>();
    `;
    const { output } = transform(fixture(src));
    expect(output).toContain('provider.resolve("./app:IRepo<./app:User>")');
  });

  test("nameof<IRepo<$<1>>>() yields the open template string", () => {
    const src = `
      ${BRANDS}
      interface IRepo<T> {}
      declare function nameof<T>(): string;
      const t = nameof<IRepo<$<1>>>();
    `;
    const { output } = transform(fixture(src));
    expect(output).toContain('const t = "./app:IRepo<$1>";');
  });
});

describe("diagnostics 990007–990010", () => {
  test("990007: bare generic class ref whose ctor references its type params", () => {
    const src = `
      ${BRANDS}
      interface IRepo<T> {}
      class SqlRepo<T> implements IRepo<T> {
        constructor(seed: T) {}
      }
      declare const services: any;
      services.add<IRepo<$<1>>>(SqlRepo).as<"singleton">();
    `;
    const { diagnostics } = transform(fixture(src));
    const diag = diagnostics.find(
      (d) => d.code === DiagnosticCode.UnboundTypeParameter,
    );
    expect(diag).toBeDefined();
    expect(diag!.category).toBe(1 /* ts.DiagnosticCategory.Error */);
    expect(String(diag!.messageText)).toContain("instantiation expression");
  });

  test("990007 negative: the instantiation-expression form binds the type params", () => {
    const src = `
      ${BRANDS}
      interface IRepo<T> {}
      class SqlRepo<T> implements IRepo<T> {
        constructor(seed: T) {}
      }
      declare const services: any;
      services.add<IRepo<$<1>>>(SqlRepo<$<1>>).as<"singleton">();
    `;
    const { diagnostics } = transform(fixture(src));
    expect(codes(diagnostics)).not.toContain(
      DiagnosticCode.UnboundTypeParameter,
    );
  });

  test("990008: service token mixing holes and concrete args", () => {
    const src = `
      ${BRANDS}
      interface IPair<A, B> {}
      class Pair<A, B> implements IPair<A, B> {
        constructor(a: A, b: B) {}
      }
      declare const services: any;
      services.add<IPair<$<1>, string>>(Pair<$<1>, string>).as<"singleton">();
    `;
    const { diagnostics } = transform(fixture(src));
    const diag = diagnostics.find(
      (d) => d.code === DiagnosticCode.MixedServiceTokenArgs,
    );
    expect(diag).toBeDefined();
    expect(diag!.category).toBe(1);
  });

  test("990008: a NESTED hole in a service-token arg is also mixed", () => {
    const src = `
      ${BRANDS}
      interface IBar<T> {}
      interface IFoo<T> {}
      class Foo<T> implements IFoo<T> {
        constructor(x: T) {}
      }
      declare const services: any;
      services.add<IFoo<IBar<$<1>>>>(Foo<IBar<$<1>>>).as<"singleton">();
    `;
    const { diagnostics } = transform(fixture(src));
    expect(codes(diagnostics)).toContain(DiagnosticCode.MixedServiceTokenArgs);
  });

  test("990008 negative: all-holes (repeats allowed) and all-concrete are both fine", () => {
    const src = `
      ${BRANDS}
      interface User {}
      interface IPair<A, B> {}
      class Pair<A, B> implements IPair<A, B> {
        constructor(a: A, b: B) {}
      }
      declare const services: any;
      services.add<IPair<$<1>, $<1>>>(Pair<$<1>, $<1>>).as<"singleton">();
      services.add<IPair<User, User>>(Pair<User, User>).as<"singleton">();
    `;
    const { diagnostics } = transform(fixture(src));
    expect(codes(diagnostics)).not.toContain(
      DiagnosticCode.MixedServiceTokenArgs,
    );
  });

  test("990009: open token on addValue", () => {
    const src = `
      ${BRANDS}
      interface IRepo<T> {}
      declare const services: any;
      services.addValue<IRepo<$<1>>>({});
    `;
    const { diagnostics } = transform(fixture(src));
    const diag = diagnostics.find(
      (d) => d.code === DiagnosticCode.OpenTokenOnValueOrFactory,
    );
    expect(diag).toBeDefined();
    expect(diag!.category).toBe(1);
    expect(String(diag!.messageText)).toContain("addValue");
  });

  test("990009: open token on a factory registration", () => {
    const src = `
      ${BRANDS}
      interface IRepo<T> {}
      declare const services: any;
      services.add<IRepo<$<1>>>(() => ({}) as IRepo<$<1>>).as<"singleton">();
    `;
    const { diagnostics } = transform(fixture(src));
    expect(codes(diagnostics)).toContain(
      DiagnosticCode.OpenTokenOnValueOrFactory,
    );
  });

  test("990009 negative: closed tokens on addValue / factories are fine", () => {
    const src = `
      interface User {}
      interface IRepo<T> {}
      declare const services: any;
      services.addValue<IRepo<User>>({});
      services.add<IRepo<User>>(() => ({}) as IRepo<User>).as<"singleton">();
    `;
    const { diagnostics } = transform(fixture(src));
    expect(codes(diagnostics)).not.toContain(
      DiagnosticCode.OpenTokenOnValueOrFactory,
    );
  });

  test("990010: a dep hole the service template does not bind", () => {
    const src = `
      ${BRANDS}
      interface IRepo<T> {}
      class SqlRepo<T> implements IRepo<$<1>> {
        constructor(seed: T) {}
      }
      declare const services: any;
      services.add<IRepo<$<1>>>(SqlRepo<$<2>>).as<"singleton">();
    `;
    const { diagnostics } = transform(fixture(src));
    const diag = diagnostics.find(
      (d) => d.code === DiagnosticCode.DepHoleNotInServiceTemplate,
    );
    expect(diag).toBeDefined();
    expect(diag!.category).toBe(1);
    expect(String(diag!.messageText)).toContain("$2");
  });

  test("990010: an unbound Typeof hole is caught too", () => {
    const src = `
      ${BRANDS}
      interface ILogger<T> {}
      class Logger<T> implements ILogger<$<1>> {
        constructor(category: Typeof<T>) {}
      }
      declare const services: any;
      services.add<ILogger<$<1>>>(Logger<$<2>>).as<"singleton">();
    `;
    const { diagnostics } = transform(fixture(src));
    expect(codes(diagnostics)).toContain(
      DiagnosticCode.DepHoleNotInServiceTemplate,
    );
  });

  test("990010 negative: dep holes bound by the service template are fine", () => {
    const src = `
      ${BRANDS}
      interface IPair<A, B> {}
      class Pair<A, B> implements IPair<A, B> {
        constructor(a: A, b: B) {}
      }
      declare const services: any;
      services.add<IPair<$<1>, $<2>>>(Pair<$<2>, $<1>>).as<"singleton">();
    `;
    const { diagnostics } = transform(fixture(src));
    expect(codes(diagnostics)).not.toContain(
      DiagnosticCode.DepHoleNotInServiceTemplate,
    );
  });
});

describe("non-generic regression", () => {
  test("a non-generic registration carries its signature inline as the third arg", () => {
    const src = `
      interface ILogger {}
      interface IRepo {}
      class ConsoleLogger implements ILogger { constructor() {} }
      class SqlRepo implements IRepo {
        constructor(log: ILogger) {}
      }
      declare const services: any;
      services.add<ILogger>(ConsoleLogger).as<"singleton">();
      services.add<IRepo>(SqlRepo).as<"request">();
    `;
    const { output, diagnostics } = transform(fixture(src));
    expect(codes(diagnostics)).toEqual([]);
    expect(output).not.toContain("defineDeps");
    expect(output).not.toContain("ɵreg");
    expect(output).toContain(
      'services.add("./app:ILogger", ConsoleLogger, [[]]).as("singleton");',
    );
    expect(output).toContain(
      'services.add("./app:IRepo", SqlRepo, [["./app:ILogger"]]).as("request");',
    );
  });
});
