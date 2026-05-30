import { test, expect, describe } from "bun:test";
import { transform, fixture } from "./harness.js";
import { DiagnosticCode } from "../src/index.js";

// Statically-visible registration diagnostics (PRD §4.5 / §8): the factory
// call-signature mismatch, the bare-`IDb`-vs-`Promise<IDb>` async mismatch, and
// equal-arity overload ambiguity. Each is conservative — it fires only when the
// mismatch is statically certain, never on an un-resolvable shape.

function codes(diags: readonly { code: number }[]): number[] {
  return diags.map((d) => d.code);
}

describe("factory-signature diagnostic (§4.5)", () => {
  test("fires when the factory takes the wrong number of args", () => {
    // Foo ctor: (a: IA, b: string) — IA is a resolvable token, b is a hole. The
    // factory must supply exactly the 1 hole; declaring 2 params is a mismatch.
    const src = `
      interface IA {}
      class B2 {}
      interface IFoo {}
      class Foo implements IFoo {
        constructor(a: IA, b: string) {}
      }
      interface ISvc {}
      class Svc implements ISvc {
        constructor(makeFoo: (x: B2, y: number) => Foo) {}
      }
      declare const services: any;
      services.add<ISvc>(Svc).as<"singleton">();
    `;
    const { diagnostics } = transform(fixture(src));
    const diag = diagnostics.find(
      (d) => d.code === DiagnosticCode.FactorySignatureMismatch,
    );
    expect(diag).toBeDefined();
    expect(diag!.category).toBe(0 /* ts.DiagnosticCategory.Warning */);
    expect(String(diag!.messageText)).toContain("makeFoo");
    expect(String(diag!.messageText)).not.toContain("lower");
  });

  test("no diagnostic when the factory arity matches the produced holes", () => {
    // Foo ctor: (a: IA registered, b: string hole) → factory supplies just b.
    const src = `
      interface IA {}
      interface IFoo {}
      class Foo implements IFoo {
        constructor(a: IA, b: string) {}
      }
      interface ISvc {}
      class Svc implements ISvc {
        constructor(makeFoo: (b: string) => Foo) {}
      }
      declare const services: any;
      services.add<ISvc>(Svc).as<"singleton">();
    `;
    const { diagnostics } = transform(fixture(src));
    expect(codes(diagnostics)).not.toContain(
      DiagnosticCode.FactorySignatureMismatch,
    );
  });

  test("fires for a hand-declared @signature factory slot with a bad arity", () => {
    // SqlUserRepo is hand-annotated via @signature (authoritative — no
    // transformer-synthesized defineDeps). Its ctor still carries an inline
    // factory param `makeFoo: (...) => Foo`. Foo's ctor has exactly one hole
    // (b: string; a: IA is resolvable), so the factory must take 1 arg; it
    // declares 2 → mismatch. The §8 factory-signature diagnostic must still
    // fire for the hand-declared slot, not be skipped by the annotated path.
    const src = `
      import { signature } from "@fnioc/core";
      interface IA {}
      class B2 {}
      interface IFoo {}
      class Foo implements IFoo {
        constructor(a: IA, b: string) {}
      }
      interface ISvc {}
      @signature("manual:IA")
      class Svc implements ISvc {
        constructor(makeFoo: (x: B2, y: number) => Foo) {}
      }
      declare const services: any;
      services.add<ISvc>(Svc).as<"singleton">();
    `;
    const { output, diagnostics } = transform(fixture(src));
    // The annotated class still skips transformer-generated defineDeps.
    expect(output).not.toContain("defineDeps(Svc");
    const diag = diagnostics.find(
      (d) => d.code === DiagnosticCode.FactorySignatureMismatch,
    );
    expect(diag).toBeDefined();
    expect(diag!.category).toBe(0 /* ts.DiagnosticCategory.Warning */);
    expect(String(diag!.messageText)).toContain("makeFoo");
    expect(String(diag!.messageText)).not.toContain("lower");
  });

  test("fires for a forCtor-annotated class factory slot with a bad arity", () => {
    const src = `
      import { forCtor } from "@fnioc/core";
      interface IA {}
      class B2 {}
      interface IFoo {}
      class Foo implements IFoo {
        constructor(a: IA, b: string) {}
      }
      interface ISvc {}
      class Svc implements ISvc {
        constructor(makeFoo: (x: B2, y: number) => Foo) {}
      }
      forCtor(Svc).signature({ factory: "manual:IFoo" });
      declare const services: any;
      services.add<ISvc>(Svc).as<"singleton">();
    `;
    const { output, diagnostics } = transform(fixture(src));
    expect(output).not.toContain("defineDeps(Svc");
    expect(codes(diagnostics)).toContain(
      DiagnosticCode.FactorySignatureMismatch,
    );
  });

  test("no diagnostic for a hand-declared factory slot with matching arity", () => {
    const src = `
      import { signature } from "@fnioc/core";
      interface IA {}
      interface IFoo {}
      class Foo implements IFoo {
        constructor(a: IA, b: string) {}
      }
      interface ISvc {}
      @signature("manual:IA")
      class Svc implements ISvc {
        constructor(makeFoo: (b: string) => Foo) {}
      }
      declare const services: any;
      services.add<ISvc>(Svc).as<"singleton">();
    `;
    const { diagnostics } = transform(fixture(src));
    expect(codes(diagnostics)).not.toContain(
      DiagnosticCode.FactorySignatureMismatch,
    );
  });

  test("silent when the produced type is an interface with no reachable class", () => {
    // The factory returns IFoo (an interface) — no concrete ctor is statically
    // reachable, so the check cannot run and must not guess.
    const src = `
      interface IFoo {}
      interface ISvc {}
      class Svc implements ISvc {
        constructor(makeFoo: (x: number) => IFoo) {}
      }
      declare const services: any;
      services.add<ISvc>(Svc).as<"singleton">();
    `;
    const { diagnostics } = transform(fixture(src));
    expect(codes(diagnostics)).not.toContain(
      DiagnosticCode.FactorySignatureMismatch,
    );
  });
});

describe("async-mismatch diagnostic", () => {
  test("fires for a bare dep whose token is registered async", () => {
    const src = `
      interface IDb {}
      interface IRepo {}
      class Repo implements IRepo {
        constructor(db: IDb) {}
      }
      declare const services: any;
      declare const container: any;
      container.register("./app/IDb", { useFactory: async () => ({}) });
      services.add<IRepo>(Repo).as<"singleton">();
    `;
    const { diagnostics } = transform(fixture(src));
    const diag = diagnostics.find(
      (d) => d.code === DiagnosticCode.AsyncMismatch,
    );
    expect(diag).toBeDefined();
    expect(String(diag!.messageText)).toContain("Promise<IDb>");
    expect(String(diag!.messageText)).not.toContain("lower");
  });

  test("no diagnostic when the dep is already declared Promise<IDb>", () => {
    const src = `
      interface IDb {}
      interface IRepo {}
      class Repo implements IRepo {
        constructor(db: Promise<IDb>) {}
      }
      declare const services: any;
      declare const container: any;
      container.register("./app/IDb", { useFactory: async () => ({}) });
      services.add<IRepo>(Repo).as<"singleton">();
    `;
    const { diagnostics } = transform(fixture(src));
    expect(codes(diagnostics)).not.toContain(DiagnosticCode.AsyncMismatch);
  });

  test("no diagnostic when the token is registered with a SYNC factory", () => {
    const src = `
      interface IDb {}
      interface IRepo {}
      class Repo implements IRepo {
        constructor(db: IDb) {}
      }
      declare const services: any;
      declare const container: any;
      container.register("./app/IDb", { useFactory: () => ({}) });
      services.add<IRepo>(Repo).as<"singleton">();
    `;
    const { diagnostics } = transform(fixture(src));
    expect(codes(diagnostics)).not.toContain(DiagnosticCode.AsyncMismatch);
  });
});

describe("equal-arity overload-ambiguity diagnostic", () => {
  test("fires for two @signature overloads of the same length", () => {
    const src = `
      import { signature } from "@fnioc/core";
      interface ISvc {}
      @signature("a", "b")
      @signature("c", "d")
      class Svc implements ISvc { constructor(x: any, y: any) {} }
      declare const services: any;
      services.add<ISvc>(Svc).as<"singleton">();
    `;
    const { diagnostics } = transform(fixture(src));
    const diag = diagnostics.find(
      (d) => d.code === DiagnosticCode.OverloadAmbiguity,
    );
    expect(diag).toBeDefined();
    expect(String(diag!.messageText)).toContain("same length");
    expect(String(diag!.messageText)).not.toContain("lower");
  });

  test("fires for two chained forCtor signatures of the same length", () => {
    const src = `
      import { forCtor } from "@fnioc/core";
      interface ISvc {}
      class Svc implements ISvc { constructor(x: any, y: any) {} }
      forCtor(Svc).signature("a", "b").signature("c", "d");
      declare const services: any;
      services.add<ISvc>(Svc).as<"singleton">();
    `;
    const { diagnostics } = transform(fixture(src));
    expect(codes(diagnostics)).toContain(DiagnosticCode.OverloadAmbiguity);
  });

  test("no diagnostic when overload arities differ", () => {
    const src = `
      import { signature } from "@fnioc/core";
      interface ISvc {}
      @signature("a", "b")
      @signature("c")
      class Svc implements ISvc { constructor(x: any, y?: any) {} }
      declare const services: any;
      services.add<ISvc>(Svc).as<"singleton">();
    `;
    const { diagnostics } = transform(fixture(src));
    expect(codes(diagnostics)).not.toContain(DiagnosticCode.OverloadAmbiguity);
  });
});
