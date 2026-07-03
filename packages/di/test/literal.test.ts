import { test, expect, describe } from "bun:test";
import { ServiceManifest, NoSatisfiableSignatureError } from "@fnioc/di";
import { union, isLiteralRef } from "@fnioc/core";
import { defineDeps } from "./fixtures.js";
import type { LiteralRef } from "@fnioc/core";
import { T } from "./fixtures.js";

// LiteralRef (Rule 2): a singular literal / nullish-singleton slot supplies its
// value directly, with NO container lookup. Always satisfiable — it never makes
// a signature unresolvable. Covers ctor args, factory args, every value kind
// (string / number / boolean / bigint / undefined / null), and the optional-
// param `union(token, LiteralRef(undefined))` fallback at resolve time.

class LoggerImpl {
  public readonly kind = "logger";
}

describe("LiteralRef core guard", () => {
  test("isLiteralRef identifies a value slot by key presence, incl. undefined", () => {
    expect(isLiteralRef({ value: "dev" })).toBe(true);
    expect(isLiteralRef({ value: 42 })).toBe(true);
    expect(isLiteralRef({ value: undefined })).toBe(true); // key present, value undefined
    expect(isLiteralRef({ value: null })).toBe(true);
    expect(isLiteralRef("pkg:IFoo")).toBe(false);
    expect(isLiteralRef({ type: "pkg:IFoo" })).toBe(false);
    expect(isLiteralRef({ scope: true })).toBe(false);
    expect(isLiteralRef({ union: [] })).toBe(false);
  });
});

describe("LiteralRef — ctor argument value supply", () => {
  test("each value kind is injected verbatim into a ctor", () => {
    class Holder {
      public constructor(
        public readonly s: unknown,
        public readonly n: unknown,
        public readonly b: unknown,
        public readonly big: unknown,
      ) {}
    }
    defineDeps(Holder, [
      [{ value: "dev" }, { value: 42 }, { value: true }, { value: 7n }],
    ]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.Service, Holder).as("singleton");

    const h = services.build().resolve<Holder>(T.Service);
    expect(h.s).toBe("dev");
    expect(h.n).toBe(42);
    expect(h.b).toBe(true);
    expect(h.big).toBe(7n);
  });

  test("undefined and null values are injected verbatim", () => {
    class Holder {
      public constructor(
        public readonly u: unknown,
        public readonly nul: unknown,
      ) {}
    }
    const undef: LiteralRef = { value: undefined };
    const nul: LiteralRef = { value: null };
    defineDeps(Holder, [[undef, nul]]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.Service, Holder).as("singleton");

    const h = services.build().resolve<Holder>(T.Service);
    expect(h.u).toBeUndefined();
    expect(h.nul).toBeNull();
  });

  test("a negative number / negative bigint value round-trips", () => {
    class Holder {
      public constructor(
        public readonly n: unknown,
        public readonly big: unknown,
      ) {}
    }
    defineDeps(Holder, [[{ value: -5 }, { value: -9n }]]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.Service, Holder).as("singleton");

    const h = services.build().resolve<Holder>(T.Service);
    expect(h.n).toBe(-5);
    expect(h.big).toBe(-9n);
  });

  test("a LiteralRef makes a signature satisfiable even when no token is registered", () => {
    // The ONLY slot is a LiteralRef — selectSignature must treat it as
    // satisfiable (no token to look up), so resolution succeeds.
    class Holder {
      public constructor(public readonly mode: unknown) {}
    }
    defineDeps(Holder, [[{ value: "prod" }]]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.Service, Holder).as("singleton");

    expect(services.build().resolve<Holder>(T.Service).mode).toBe("prod");
  });
});

describe("LiteralRef — factory argument value supply", () => {
  test("a value slot is injected into a registered factory function", () => {
    const factory = (mode: unknown, log: unknown): { mode: unknown; log: unknown } => ({
      mode,
      log,
    });
    defineDeps(factory, [[{ value: "dev" }, T.Logger]]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.Logger, LoggerImpl).as("singleton");
    services.addFactory(T.Service, factory).as("singleton");

    const out = services.build().resolve<{ mode: unknown; log: unknown }>(T.Service);
    expect(out.mode).toBe("dev");
    expect(out.log).toBeInstanceOf(LoggerImpl);
  });
});

describe("optional param fallback — union(token, LiteralRef(undefined))", () => {
  test("token unregistered → undefined supplied by the LiteralRef fallback", () => {
    // The exact slot shape the transformer emits for `dep?: IFoo`.
    class Consumer {
      public constructor(public readonly dep: unknown) {}
    }
    defineDeps(Consumer, [[union(T.A, { value: undefined })]]);

    const services = new ServiceManifest<"singleton">();
    // T.A deliberately NOT registered — the union falls to the LiteralRef.
    services.add(T.Service, Consumer).as("singleton");

    expect(services.build().resolve<Consumer>(T.Service).dep).toBeUndefined();
  });

  test("token registered → the instance wins over the undefined fallback", () => {
    class Consumer {
      public constructor(public readonly dep: unknown) {}
    }
    defineDeps(Consumer, [[union(T.A, { value: undefined })]]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.A, LoggerImpl).as("singleton");
    services.add(T.Service, Consumer).as("singleton");

    expect(services.build().resolve<Consumer>(T.Service).dep).toBeInstanceOf(LoggerImpl);
  });

  test("optional `X | null` fallback supplies null when X is unregistered", () => {
    class Consumer {
      public constructor(public readonly dep: unknown) {}
    }
    defineDeps(Consumer, [[union(T.A, { value: null })]]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.Service, Consumer).as("singleton");

    expect(services.build().resolve<Consumer>(T.Service).dep).toBeNull();
  });

  test("the LiteralRef-fallback union never throws NoSatisfiableSignatureError", () => {
    // Because the LiteralRef member is always satisfiable, selectSignature always
    // finds the union satisfiable — even with the real token unregistered.
    class Consumer {
      public constructor(public readonly dep: unknown) {}
    }
    defineDeps(Consumer, [[union(T.A, { value: undefined })]]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.Service, Consumer).as("singleton");

    expect(() => services.build().resolve(T.Service)).not.toThrow(
      NoSatisfiableSignatureError,
    );
  });

  test("registered 'boolean' token injects into optional boolean param (Fix 1)", () => {
    // Transformer emits union("boolean", { value: undefined }) for `flag?: boolean`.
    // The registered value under "boolean" must win over the LiteralRef fallback.
    class Consumer {
      public constructor(public readonly flag: unknown) {}
    }
    // Shape the transformer emits for `flag?: boolean` after the fix.
    defineDeps(Consumer, [[union("boolean", { value: undefined })]]);

    const services = new ServiceManifest<"singleton">();
    services.addValue("boolean", true); // register a boolean value
    services.add(T.Service, Consumer).as("singleton");

    expect(services.build().resolve<Consumer>(T.Service).flag).toBe(true);
  });

  test("optional boolean falls through to undefined when 'boolean' is unregistered", () => {
    class Consumer {
      public constructor(public readonly flag: unknown) {}
    }
    defineDeps(Consumer, [[union("boolean", { value: undefined })]]);

    const services = new ServiceManifest<"singleton">();
    // "boolean" NOT registered — union falls through to the LiteralRef.
    services.add(T.Service, Consumer).as("singleton");

    expect(services.build().resolve<Consumer>(T.Service).flag).toBeUndefined();
  });
});
