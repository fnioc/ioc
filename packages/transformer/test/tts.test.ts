import { test, expect, describe } from "bun:test";
import { transform, fixture, type VirtualFiles } from "./harness.js";
import { DiagnosticCode } from "../src/index.js";

// Token Surface (TTS) feature tests.
//
// Covers the T-transformer slice of the token-surface redesign:
//   - Inject<T, "tok"> brand detection (design §3 / §5)
//   - Inline union lowering (design §8)
//   - Named alias NOT a union (design §8, named-vs-inline)
//   - T | undefined optional param stays optional (not a union)
//   - Hard error for unbranded underivable types (design §5)
//   - resolveFactory param extraction (design §2)
//   - Registration-time override merge (design §6)

// ── helper ────────────────────────────────────────────────────────────────────

function depsArrayFor(output: string, ctor: string): string {
  const hoistMatch = output.match(new RegExp(`const (ɵreg\\d+) = ${ctor};`));
  if (!hoistMatch) throw new Error(`no hoisted const for ${ctor} in:\n${output}`);
  const regName = hoistMatch[1]!;
  const marker = `defineDeps(${regName}, `;
  const start = output.indexOf(marker);
  if (start < 0) throw new Error(`no defineDeps for ${regName} in:\n${output}`);
  const from = start + marker.length;
  const end = output.indexOf("]);", from);
  return output.slice(from, end + 1);
}

// ── Inject<T, "tok"> brand detection ─────────────────────────────────────────

describe("Inject brand detection (§3 / §5)", () => {
  test("Inject<T, 'tok'> branded param uses the branded token, not structural derivation", () => {
    // The transformer reads the Inject brand's string literal and uses it as the
    // token, bypassing normal derivation. The type could be an interface that
    // would normally derive its own token — the brand wins.
    const files: VirtualFiles = {
      "/proj/node_modules/@fnioc/core/package.json": JSON.stringify({
        name: "@fnioc/core",
        version: "1.0.0",
        exports: { ".": "./index.js" },
      }),
      "/proj/node_modules/@fnioc/core/index.d.ts": `
        declare const TOK: unique symbol;
        export type Inject<T, K extends string> = T & { readonly [TOK]?: K };
      `,
      "/proj/src/app.ts": `
        import type { Inject } from "@fnioc/core";
        interface ICache {}
        interface ISvc {}
        class Svc implements ISvc {
          constructor(cache: Inject<ICache, "pkg:redis-cache">) {}
        }
        declare const services: any;
        services.add<ISvc>(Svc).as<"singleton">();
      `,
    };
    const { outputs } = transform(files, { entry: ["/proj/src/app.ts"] });
    const out = outputs["/proj/src/app.ts"]!;
    const arr = depsArrayFor(out, "Svc");
    expect(arr).toBe('[["pkg:redis-cache"]]');
    // The brand token was used, not a structurally-derived token for ICache.
    expect(arr).not.toContain("ICache");
  });

  test("Inject brand works for a symbol-less anonymous type (escape hatch)", () => {
    // An anonymous / structural type with no name cannot be tokenized normally.
    // Inject<T, "my:opts"> brands it with an explicit token, escaping the hard error.
    const files: VirtualFiles = {
      "/proj/node_modules/@fnioc/core/package.json": JSON.stringify({
        name: "@fnioc/core",
        version: "1.0.0",
        exports: { ".": "./index.js" },
      }),
      "/proj/node_modules/@fnioc/core/index.d.ts": `
        declare const TOK: unique symbol;
        export type Inject<T, K extends string> = T & { readonly [TOK]?: K };
      `,
      "/proj/src/app.ts": `
        import type { Inject } from "@fnioc/core";
        interface ISvc {}
        class Svc implements ISvc {
          constructor(opts: Inject<{ n: number }, "my:opts">) {}
        }
        declare const services: any;
        services.add<ISvc>(Svc).as<"singleton">();
      `,
    };
    const { outputs, diagnostics } = transform(files, {
      entry: ["/proj/src/app.ts"],
    });
    const out = outputs["/proj/src/app.ts"]!;
    // Branded → no hard error, uses the branded token.
    expect(
      diagnostics.filter((d) => d.code === DiagnosticCode.UnderivableToken).length,
    ).toBe(0);
    expect(depsArrayFor(out, "Svc")).toBe('[["my:opts"]]');
  });

  test("Inject brand on optional param (x?: Inject<T, K>) uses branded token", () => {
    // When the param is optional the resolved type is `(T & { [TOK]?: K }) | undefined`.
    // getPropertiesOfType on that union omits the brand (undefined contributes no
    // properties). The fix iterates union members, skips undefined, and finds the brand.
    const files: VirtualFiles = {
      "/proj/node_modules/@fnioc/core/package.json": JSON.stringify({
        name: "@fnioc/core",
        version: "1.0.0",
        exports: { ".": "./index.js" },
      }),
      "/proj/node_modules/@fnioc/core/index.d.ts": `
        declare const TOK: unique symbol;
        export type Inject<T, K extends string> = T & { readonly [TOK]?: K };
      `,
      "/proj/src/app.ts": `
        import type { Inject } from "@fnioc/core";
        interface ISvc {}
        class Svc implements ISvc {
          constructor(opts?: Inject<{ n: number }, "my:opts">) {}
        }
        declare const services: any;
        services.add<ISvc>(Svc).as<"singleton">();
      `,
    };
    const { outputs, diagnostics } = transform(files, {
      entry: ["/proj/src/app.ts"],
    });
    const out = outputs["/proj/src/app.ts"]!;
    expect(
      diagnostics.filter((d) => d.code === DiagnosticCode.UnderivableToken).length,
    ).toBe(0);
    expect(depsArrayFor(out, "Svc")).toContain('"my:opts"');
  });

  test("Inject brand on explicit-union optional param (x: Inject<T, K> | undefined) uses branded token", () => {
    // `x: Inject<T, K> | undefined` is the explicit-union form of an optional param;
    // the resolved type is identical to `x?: Inject<T, K>` — the brand must survive.
    const files: VirtualFiles = {
      "/proj/node_modules/@fnioc/core/package.json": JSON.stringify({
        name: "@fnioc/core",
        version: "1.0.0",
        exports: { ".": "./index.js" },
      }),
      "/proj/node_modules/@fnioc/core/index.d.ts": `
        declare const TOK: unique symbol;
        export type Inject<T, K extends string> = T & { readonly [TOK]?: K };
      `,
      "/proj/src/app.ts": `
        import type { Inject } from "@fnioc/core";
        interface ISvc {}
        class Svc implements ISvc {
          constructor(opts: Inject<{ n: number }, "my:opts"> | undefined) {}
        }
        declare const services: any;
        services.add<ISvc>(Svc).as<"singleton">();
      `,
    };
    const { outputs, diagnostics } = transform(files, {
      entry: ["/proj/src/app.ts"],
    });
    const out = outputs["/proj/src/app.ts"]!;
    expect(
      diagnostics.filter((d) => d.code === DiagnosticCode.UnderivableToken).length,
    ).toBe(0);
    expect(depsArrayFor(out, "Svc")).toContain('"my:opts"');
  });

  test("mixed branded + normal params: branded wins for branded, normal for others", () => {
    const files: VirtualFiles = {
      "/proj/node_modules/@fnioc/core/package.json": JSON.stringify({
        name: "@fnioc/core",
        version: "1.0.0",
        exports: { ".": "./index.js" },
      }),
      "/proj/node_modules/@fnioc/core/index.d.ts": `
        declare const TOK: unique symbol;
        export type Inject<T, K extends string> = T & { readonly [TOK]?: K };
      `,
      "/proj/src/app.ts": `
        import type { Inject } from "@fnioc/core";
        interface ICache {}
        interface ILogger {}
        interface ISvc {}
        class Svc implements ISvc {
          constructor(
            cache: Inject<ICache, "pkg:redis-cache">,
            log: ILogger,
          ) {}
        }
        declare const services: any;
        services.add<ISvc>(Svc).as<"singleton">();
      `,
    };
    const { outputs } = transform(files, { entry: ["/proj/src/app.ts"] });
    const out = outputs["/proj/src/app.ts"]!;
    // First param: branded → "pkg:redis-cache"
    // Second param: normal derivation → "./app/ILogger" source-relative token
    const arr = depsArrayFor(out, "Svc");
    expect(arr).toContain('"pkg:redis-cache"');
    expect(arr).toContain('"./app/ILogger"');
  });
});

// ── Inline union lowering (design §8) ─────────────────────────────────────────

describe("inline union lowering (§8)", () => {
  test("A | B ctor param → UnionSlot { union: [tokenA, tokenB] }", () => {
    const src = `
      interface IRedis {}
      interface IMemoryCache {}
      interface IHandler {}
      class Handler implements IHandler {
        constructor(cache: IRedis | IMemoryCache) {}
      }
      declare const services: any;
      services.add<IHandler>(Handler).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    expect(depsArrayFor(output, "Handler")).toBe(
      '[[{ union: ["./app/IRedis", "./app/IMemoryCache"] }]]',
    );
  });

  test("three-member inline union → UnionSlot with three members", () => {
    const src = `
      interface IA {}
      interface IB {}
      interface IC {}
      interface IHandler {}
      class Handler implements IHandler {
        constructor(dep: IA | IB | IC) {}
      }
      declare const services: any;
      services.add<IHandler>(Handler).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    expect(depsArrayFor(output, "Handler")).toBe(
      '[[{ union: ["./app/IA", "./app/IB", "./app/IC"] }]]',
    );
  });

  test("inline union mixes with plain token in one signature", () => {
    const src = `
      interface IRedis {}
      interface IMemoryCache {}
      interface ILogger {}
      interface IHandler {}
      class Handler implements IHandler {
        constructor(cache: IRedis | IMemoryCache, log: ILogger) {}
      }
      declare const services: any;
      services.add<IHandler>(Handler).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    expect(depsArrayFor(output, "Handler")).toBe(
      '[[{ union: ["./app/IRedis", "./app/IMemoryCache"] }, "./app/ILogger"]]',
    );
  });

  test("named type alias type AB = A | B → single token (NO union) — the named-vs-inline rule", () => {
    // This is the most critical behavioural test per design §8.
    // `type CacheProvider = IRedis | IMemoryCache` referenced as `x: CacheProvider`
    // appears as a TypeReferenceNode at the annotation site — NOT a UnionTypeNode.
    // So it derives the alias's OWN single token, not a union.
    const src = `
      interface IRedis {}
      interface IMemoryCache {}
      type CacheProvider = IRedis | IMemoryCache;
      interface IHandler {}
      class Handler implements IHandler {
        constructor(cache: CacheProvider) {}
      }
      declare const services: any;
      services.add<IHandler>(Handler).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    // Must produce a single token for CacheProvider, NOT a union.
    const arr = depsArrayFor(output, "Handler");
    expect(arr).not.toContain("union:");
    expect(arr).toContain("CacheProvider");
  });

  test("T | undefined optional param does NOT become a union slot", () => {
    // `dep?: IFoo` (or `dep: IFoo | undefined`) is optional-overload territory —
    // the `| undefined` is the optionality marker, not a union of alternatives.
    // The transformer strips it and uses IFoo's token, producing optional overloads.
    const src = `
      interface IFoo {}
      interface IHandler {}
      class Handler implements IHandler {
        constructor(dep?: IFoo) {}
      }
      declare const services: any;
      services.add<IHandler>(Handler).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    // Two overloads: [["./app/IFoo"], []] (with optional dep, without).
    const arr = depsArrayFor(output, "Handler");
    expect(arr).not.toContain("union:");
    expect(arr).toContain("./app/IFoo");
    // The shorter overload (dep omitted) must also be present.
    expect(arr).toContain("[]");
  });
});

// ── Hard error for unresolvable types (design §5) ─────────────────────────────

describe("hard error on unresolvable token (§5)", () => {
  test("unbranded primitive param type produces error diagnostic", () => {
    const src = `
      interface ISvc {}
      class Svc implements ISvc {
        constructor(name: string) {}
      }
      declare const services: any;
      services.add<ISvc>(Svc).as<"singleton">();
    `;
    const { diagnostics } = transform(fixture(src));
    const errs = diagnostics.filter((d) => d.code === DiagnosticCode.UnderivableToken);
    expect(errs.length).toBe(1);
    expect(errs[0]!.category).toBe(1 /* ts.DiagnosticCategory.Error */);
    expect(String(errs[0]!.messageText)).toContain("Inject<T");
  });

  test("anonymous structural type produces error diagnostic", () => {
    const src = `
      interface ISvc {}
      class Svc implements ISvc {
        constructor(opts: { port: number }) {}
      }
      declare const services: any;
      services.add<ISvc>(Svc).as<"singleton">();
    `;
    const { diagnostics } = transform(fixture(src));
    const errs = diagnostics.filter((d) => d.code === DiagnosticCode.UnderivableToken);
    expect(errs.length).toBeGreaterThanOrEqual(1);
  });

  test("named interface param has NO error — it tokenizes normally", () => {
    const src = `
      interface ILogger {}
      interface ISvc {}
      class Svc implements ISvc {
        constructor(log: ILogger) {}
      }
      declare const services: any;
      services.add<ISvc>(Svc).as<"singleton">();
    `;
    const { diagnostics } = transform(fixture(src));
    const errs = diagnostics.filter((d) => d.code === DiagnosticCode.UnderivableToken);
    expect(errs.length).toBe(0);
  });
});

// ── resolveFactory param extraction (design §2) ───────────────────────────────

describe("resolveFactory lowering with params (§2)", () => {
  test("resolve<(a: A, b: B) => T>() → resolveFactory('T', ['A', 'B'])", () => {
    const src = `
      interface IA {}
      interface IB {}
      interface IT {}
      declare const scope: any;
      scope.resolve<(a: IA, b: IB) => IT>();
    `;
    const { output } = transform(fixture(src));
    // The return-type token is the first arg; param tokens follow.
    expect(output).toContain(
      'scope.resolveFactory("./app/IT", ["./app/IA", "./app/IB"])',
    );
  });

  test("resolve<() => T>() → resolveFactory('T') — zero params, no array emitted", () => {
    const src = `
      interface IT {}
      declare const scope: any;
      scope.resolve<() => IT>();
    `;
    const { output } = transform(fixture(src));
    // Zero-param form: no params array.
    expect(output).toContain('scope.resolveFactory("./app/IT")');
    expect(output).not.toContain("resolveFactory(\"./app/IT\", [");
  });

  test("resolve<(a: A) => T>() → single-param form", () => {
    const src = `
      interface IA {}
      interface IT {}
      declare const scope: any;
      scope.resolve<(a: IA) => IT>();
    `;
    const { output } = transform(fixture(src));
    expect(output).toContain(
      'scope.resolveFactory("./app/IT", ["./app/IA"])',
    );
  });

  test("resolve<(a: string) => T>() with unresolvable param → hard error", () => {
    // A primitive param in the resolveFactory function type → UnderivableToken.
    const src = `
      interface IT {}
      declare const scope: any;
      scope.resolve<(name: string) => IT>();
    `;
    const { diagnostics } = transform(fixture(src));
    const errs = diagnostics.filter((d) => d.code === DiagnosticCode.UnderivableToken);
    expect(errs.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Registration-time override merge (design §6) ─────────────────────────────

describe("registration-time override merge (§6)", () => {
  test("undefined gap in override array keeps the derived token", () => {
    // add<ICache>(RedisCache, [undefined, "pkg:ILogger"]) —
    // position 0 = undefined (keep derived); position 1 = override "pkg:ILogger".
    const src = `
      interface IRedisClient {}
      interface ILogger {}
      interface ICache {}
      class RedisCache implements ICache {
        constructor(client: IRedisClient, log: ILogger) {}
      }
      declare const services: any;
      services.add<ICache>(RedisCache, [undefined, "pkg:ILogger"]).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    const arr = depsArrayFor(output, "RedisCache");
    // Position 0: derived token for IRedisClient.
    expect(arr).toContain('"./app/IRedisClient"');
    // Position 1: overridden to "pkg:ILogger".
    expect(arr).toContain('"pkg:ILogger"');
    // The derived "./app/ILogger" must NOT appear (it was overridden).
    expect(arr).not.toContain('"./app/ILogger"');
  });

  test("non-undefined override replaces the derived token at that position", () => {
    const src = `
      interface IRedisClient {}
      interface ILogger {}
      interface ICache {}
      class RedisCache implements ICache {
        constructor(client: IRedisClient, log: ILogger) {}
      }
      declare const services: any;
      services.add<ICache>(RedisCache, ["pkg:IRedisClient", "pkg:ILogger"]).as<"singleton">();
    `;
    const { output } = transform(fixture(src));
    const arr = depsArrayFor(output, "RedisCache");
    expect(arr).toContain('"pkg:IRedisClient"');
    expect(arr).toContain('"pkg:ILogger"');
    // The derived tokens must NOT appear.
    expect(arr).not.toContain('"./app/IRedisClient"');
    expect(arr).not.toContain('"./app/ILogger"');
  });
});
