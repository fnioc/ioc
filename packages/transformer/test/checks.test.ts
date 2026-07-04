import { test, expect, describe } from "bun:test";
import { transform, fixture } from "./harness.js";
import { DiagnosticCode } from "../src/index.js";

// Statically-visible registration diagnostics (PRD §4.5 / §8): the factory
// call-signature mismatch. Conservative — it fires only when the mismatch is
// statically certain, never on an un-resolvable shape.

function codes(diags: readonly { code: number }[]): number[] {
  return diags.map((d) => d.code);
}

describe("factory-signature diagnostic (§4.5)", () => {
  test("fires when the factory declares fewer params than the produced ctor has holes", () => {
    // Foo ctor: (a: string, b: number) — both holes (primitives). The factory
    // declares only 1 param but there are 2 holes that must be covered → mismatch.
    const src = `
      interface IFoo {}
      class Foo implements IFoo {
        constructor(a: string, b: number) {}
      }
      interface ISvc {}
      class Svc implements ISvc {
        constructor(makeFoo: (x: string) => Foo) {}
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

  test("fires when the factory declares more params than the produced ctor has total slots", () => {
    // Foo ctor: (a: IA, b: string) — 2 total slots. Declaring 3 factory params
    // exceeds the ctor's slot count → mismatch.
    const src = `
      interface IA {}
      interface IFoo {}
      class Foo implements IFoo {
        constructor(a: IA, b: string) {}
      }
      interface ISvc {}
      class Svc implements ISvc {
        constructor(makeFoo: (x: IA, y: string, z: number) => Foo) {}
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

  test("no diagnostic when factory additionally declares a registered-service override", () => {
    // Foo ctor: (a: IA registered, b: string hole) — 1 hole, 2 total slots. The
    // factory declares both (override IA + cover the string hole) → valid.
    const src = `
      interface IA {}
      interface IFoo {}
      class Foo implements IFoo {
        constructor(a: IA, b: string) {}
      }
      interface ISvc {}
      class Svc implements ISvc {
        constructor(makeFoo: (a: IA, b: string) => Foo) {}
      }
      declare const services: any;
      services.add<ISvc>(Svc).as<"singleton">();
    `;
    const { diagnostics } = transform(fixture(src));
    expect(codes(diagnostics)).not.toContain(
      DiagnosticCode.FactorySignatureMismatch,
    );
  });

  test("fires with an inline override array and a factory slot with too few params", () => {
    // Foo ctor: (a: string, b: number) — both holes. Factory declares only 1 → mismatch.
    // The registration carries an inline override array; the check still fires.
    const src = `
      interface IFoo {}
      class Foo implements IFoo {
        constructor(a: string, b: number) {}
      }
      interface ISvc {}
      class Svc implements ISvc {
        constructor(makeFoo: (x: string) => Foo) {}
      }
      declare const services: any;
      services.add<ISvc>(Svc, ["manual:IFoo"]).as<"singleton">();
    `;
    const { output, diagnostics } = transform(fixture(src));
    expect(output).not.toContain("defineDeps(Svc");
    expect(codes(diagnostics)).toContain(
      DiagnosticCode.FactorySignatureMismatch,
    );
  });

  test("no diagnostic with an inline override array and a matching-arity factory slot", () => {
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
      services.add<ISvc>(Svc, ["manual:IA"]).as<"singleton">();
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
