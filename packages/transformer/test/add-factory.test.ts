import { test, expect, describe } from "bun:test";
import { transform, fixture } from "./harness.js";

// The explicit tokenless factory authoring form `addFactory<I>(fn)`. It ALWAYS
// lowers to `addFactory("token", fn, [[...]])` — the factory path — with the token
// derived from `<I>` exactly like `add<I>`. Only the SINGLE-arg authored form
// lowers; the already-lowered runtime form (`addFactory("token", fn, sigs?)`,
// string first) is left untouched.

describe("addFactory<I>(fn) recognition + lowering", () => {
  test("inline factory lowers to addFactory(\"token\", fn, [[...]])", () => {
    const src = `
      interface IA {}
      interface IB {}
      interface IThing {}
      declare const services: any;
      services.addFactory<IThing>((a: IA, b: IB) => ({} as IThing));
    `;
    const { output } = transform(fixture(src));
    // Token from <IThing>, routed to addFactory with the inline signature.
    expect(output).toContain('addFactory("./app:IThing"');
    expect(output).toContain('[["./app:IA", "./app:IB"]]');
  });

  test("no-type-arg addFactory(fn) infers the token from the produced type", () => {
    const src = `
      interface IThing {}
      declare const services: any;
      services.addFactory((): IThing => ({} as IThing));
    `;
    const { output } = transform(fixture(src));
    // The <I> is inferred from the factory's return type — same token as explicit.
    expect(output).toContain('addFactory("./app:IThing"');
  });

  test("a factory reference lowers via its call signature", () => {
    const src = `
      interface IA {}
      interface IThing {}
      declare function makeThing(a: IA): IThing;
      declare const services: any;
      services.addFactory<IThing>(makeThing);
    `;
    const { output } = transform(fixture(src));
    expect(output).toContain('addFactory("./app:IThing", makeThing, [["./app:IA"]])');
  });

  test("the already-lowered runtime form (string first, 2+ args) is left untouched", () => {
    const src = `
      interface IA {}
      declare function makeThing(a: IA): unknown;
      declare const services: any;
      services.addFactory("my:tok", makeThing, [["my:dep"]]);
    `;
    const { output } = transform(fixture(src));
    // String-first, three args → already lowered: no token re-derivation, no
    // second signature injected, callee name unchanged.
    expect(output).toContain('addFactory("my:tok", makeThing, [["my:dep"]])');
    expect(output).not.toContain("./app:");
  });
});
