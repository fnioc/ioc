import { test, expect, describe } from "bun:test";
import { transform, fixture } from "./harness.js";
import { DiagnosticCode } from "../src/index.js";

// Basic edge-case behaviour (PRD §8) — NOT the Phase-2D factory diagnostic.

describe("already-annotated classes", () => {
  test("@signature-decorated class: skip defineDeps + info diagnostic", () => {
    const src = `
      import { signature } from "@fnioc/core";
      interface ILogger {}
      interface IUserRepo {}
      @signature("manual:ILogger")
      class SqlUserRepo implements IUserRepo {
        constructor(log: ILogger) {}
      }
      declare const services: any;
      services.add<IUserRepo>(SqlUserRepo).as<"request">();
    `;
    const { output, diagnostics } = transform(fixture(src));

    // The registration is STILL lowered (token + .as), but NO defineDeps is
    // emitted for the annotated class — the manual annotation is authoritative.
    expect(output).toContain('services.add("./app/IUserRepo", SqlUserRepo).as("request")');
    expect(output).not.toContain("defineDeps(SqlUserRepo");

    // An info diagnostic is raised (never silent).
    const info = diagnostics.find(
      (d) => d.code === DiagnosticCode.AlreadyAnnotated,
    );
    expect(info).toBeDefined();
    expect(info!.category).toBe(3 /* ts.DiagnosticCategory.Message */);
    expect(String(info!.messageText)).toContain("SqlUserRepo");
  });

  test("forCtor-annotated class: skip defineDeps + info diagnostic", () => {
    const src = `
      import { forCtor } from "@fnioc/core";
      interface ILogger {}
      interface IThirdParty {}
      class ThirdPartyService implements IThirdParty {
        constructor(log: ILogger) {}
      }
      forCtor(ThirdPartyService).signature("manual:ILogger");
      declare const services: any;
      services.add<IThirdParty>(ThirdPartyService).as<"singleton">();
    `;
    const { output, diagnostics } = transform(fixture(src));

    expect(output).not.toContain("defineDeps(ThirdPartyService");
    expect(output).toContain('services.add("./app/IThirdParty", ThirdPartyService)');
    expect(
      diagnostics.some((d) => d.code === DiagnosticCode.AlreadyAnnotated),
    ).toBe(true);
  });

  test("non-annotated class still gets defineDeps (no false positive)", () => {
    const src = `
      interface IFoo {}
      class Foo implements IFoo { constructor() {} }
      declare const services: any;
      services.add<IFoo>(Foo).as<"singleton">();
    `;
    const { output, diagnostics } = transform(fixture(src));
    // Non-annotated → transformer emits defineDeps against the hoisted const.
    expect(output).toContain("defineDeps(ɵreg0, [[]])");
    expect(
      diagnostics.some((d) => d.code === DiagnosticCode.AlreadyAnnotated),
    ).toBe(false);
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
    expect(output).toContain('services.add("./app/IFoo", Ctor).as("singleton")');
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
    expect(output).toContain('services.add("./app/IFoo", makeCtor()).as("singleton")');
  });
});
