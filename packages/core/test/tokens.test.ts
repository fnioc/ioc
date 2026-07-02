import { test, expect, describe } from "bun:test";
import {
  closeToken,
  parseToken,
  isOpenToken,
  substituteToken,
  substituteSignatures,
  typeArg,
  union,
} from "@fnioc/core";
import type { DepSlot } from "@fnioc/core";

// ── closeToken ────────────────────────────────────────────────────────────────

describe("closeToken", () => {
  test("renders base<arg> for one arg", () => {
    expect(closeToken("pkg:IFoo", "pkg:IBar")).toBe("pkg:IFoo<pkg:IBar>");
  });

  test("renders base<a,b> for multiple args — no whitespace around separators", () => {
    expect(closeToken("pkg:IMap", "string", "./src/User")).toBe(
      "pkg:IMap<string,./src/User>",
    );
  });

  test("no args returns the base unchanged", () => {
    expect(closeToken("pkg:IFoo")).toBe("pkg:IFoo");
  });

  test("args may themselves be closed-generic tokens (nesting)", () => {
    const inner = closeToken("pkg:IBar", "./src/Baz");
    expect(closeToken("pkg:IFoo", inner)).toBe("pkg:IFoo<pkg:IBar<./src/Baz>>");
  });

  test("hole args render an open template", () => {
    expect(closeToken("app/IRepository", "$1")).toBe("app/IRepository<$1>");
  });
});

// ── parseToken ────────────────────────────────────────────────────────────────

describe("parseToken", () => {
  test("non-generic token → undefined", () => {
    expect(parseToken("pkg:IFoo")).toBeUndefined();
    expect(parseToken("./src/Baz")).toBeUndefined();
  });

  test("single arg", () => {
    expect(parseToken("pkg:IFoo<pkg:IBar>")).toEqual({
      base: "pkg:IFoo",
      args: ["pkg:IBar"],
    });
  });

  test("multiple args split at top-level commas only", () => {
    expect(parseToken("pkg:IMap<string,./src/User>")).toEqual({
      base: "pkg:IMap",
      args: ["string", "./src/User"],
    });
  });

  test("nested generics stay whole in the arg list", () => {
    expect(parseToken("pkg:IFoo<pkg:IBar<./src/Baz>,number>")).toEqual({
      base: "pkg:IFoo",
      args: ["pkg:IBar<./src/Baz>", "number"],
    });
  });

  test("deeply nested — only the top level splits", () => {
    expect(parseToken("a<b<c<d,e>,f>,g>")).toEqual({
      base: "a",
      args: ["b<c<d,e>,f>", "g"],
    });
  });

  test("quoted literal arg keeps commas and spaces inside quotes", () => {
    expect(parseToken('app/IValidator<"a,b" | "c d">')).toEqual({
      base: "app/IValidator",
      args: ['"a,b" | "c d"'],
    });
  });

  test("quoted literal arg containing angle brackets does not disturb depth", () => {
    expect(parseToken('app/IParser<"<html>",./src/Doc>')).toEqual({
      base: "app/IParser",
      args: ['"<html>"', "./src/Doc"],
    });
  });

  test("nested generic with a quoted literal-union arg", () => {
    expect(parseToken('pkg:IFoo<pkg:IMode<"dev" | "prod">,string>')).toEqual({
      base: "pkg:IFoo",
      args: ['pkg:IMode<"dev" | "prod">', "string"],
    });
  });

  test("hole args parse like any other arg token", () => {
    expect(parseToken("app/IRepository<$1,$2>")).toEqual({
      base: "app/IRepository",
      args: ["$1", "$2"],
    });
  });

  describe("malformed → undefined", () => {
    test("unclosed bracket", () => {
      expect(parseToken("pkg:IFoo<pkg:IBar")).toBeUndefined();
      expect(parseToken("pkg:IFoo<")).toBeUndefined();
    });

    test("empty base", () => {
      expect(parseToken("<pkg:IBar>")).toBeUndefined();
    });

    test("empty arg", () => {
      expect(parseToken("pkg:IFoo<>")).toBeUndefined();
      expect(parseToken("pkg:IFoo<a,>")).toBeUndefined();
      expect(parseToken("pkg:IFoo<,a>")).toBeUndefined();
    });

    test("trailing text after the closing bracket", () => {
      expect(parseToken("pkg:IFoo<a>x")).toBeUndefined();
      expect(parseToken("pkg:IFoo<a>>")).toBeUndefined();
    });

    test("stray closing bracket in the base", () => {
      expect(parseToken("pkg:IFoo><a>")).toBeUndefined();
    });

    test("unterminated quote", () => {
      expect(parseToken('pkg:IFoo<"a>')).toBeUndefined();
    });

    test("empty string", () => {
      expect(parseToken("")).toBeUndefined();
    });
  });

  test("round-trip: parse of a closeToken render reproduces base and args", () => {
    const token = closeToken("pkg:IFoo", "pkg:IBar<./src/Baz>", '"a" | "b"');
    expect(parseToken(token)).toEqual({
      base: "pkg:IFoo",
      args: ["pkg:IBar<./src/Baz>", '"a" | "b"'],
    });
  });
});

// ── isOpenToken ───────────────────────────────────────────────────────────────

describe("isOpenToken", () => {
  test("a bare hole is open", () => {
    expect(isOpenToken("$1")).toBe(true);
    expect(isOpenToken("$9")).toBe(true);
    expect(isOpenToken("$12")).toBe(true);
  });

  test("a template with a hole arg is open", () => {
    expect(isOpenToken("app/IRepository<$1>")).toBe(true);
    expect(isOpenToken("pkg:IMap<string,$2>")).toBe(true);
  });

  test("a hole nested below the top level is still open", () => {
    expect(isOpenToken("pkg:IFoo<pkg:IBar<$1>>")).toBe(true);
    expect(isOpenToken("a<b<c<$3>>,d>")).toBe(true);
  });

  test("closed tokens are not open", () => {
    expect(isOpenToken("pkg:IFoo")).toBe(false);
    expect(isOpenToken("pkg:IFoo<pkg:IBar>")).toBe(false);
    expect(isOpenToken("pkg:IFoo<pkg:IBar<./src/Baz>,number>")).toBe(false);
  });

  test("hole-lookalikes are not holes: quoted literal, $0, prefix/suffix text", () => {
    expect(isOpenToken('pkg:IFoo<"$1">')).toBe(false);
    expect(isOpenToken("pkg:IFoo<$0>")).toBe(false);
    expect(isOpenToken("pkg:IFoo<x$1>")).toBe(false);
    expect(isOpenToken("pkg:IFoo<$1x>")).toBe(false);
  });
});

// ── substituteToken ───────────────────────────────────────────────────────────

describe("substituteToken", () => {
  test("a bare hole is replaced by its 1-based arg", () => {
    expect(substituteToken("$1", ["./src/User"])).toBe("./src/User");
    expect(substituteToken("$2", ["a", "b"])).toBe("b");
  });

  test("holes in arg positions are substituted", () => {
    expect(substituteToken("app/IRepository<$1>", ["./src/User"])).toBe(
      "app/IRepository<./src/User>",
    );
  });

  test("repeated holes substitute the same arg", () => {
    expect(substituteToken("pkg:IPair<$1,$1>", ["x"])).toBe("pkg:IPair<x,x>");
  });

  test("mixed template — concrete args untouched", () => {
    expect(substituteToken("pkg:IMap<string,$1>", ["./src/User"])).toBe(
      "pkg:IMap<string,./src/User>",
    );
  });

  test("nested holes are substituted at depth", () => {
    expect(substituteToken("pkg:IFoo<pkg:IBar<$1>,$2>", ["a", "b"])).toBe(
      "pkg:IFoo<pkg:IBar<a>,b>",
    );
  });

  test("an arg may itself be a closed-generic token", () => {
    expect(substituteToken("app/IRepository<$1>", ["pkg:IList<./src/User>"])).toBe(
      "app/IRepository<pkg:IList<./src/User>>",
    );
  });

  test("a $N inside a quoted literal arg is NOT substituted (not naive replace)", () => {
    expect(substituteToken('pkg:IFoo<"$1",$1>', ["x"])).toBe('pkg:IFoo<"$1",x>');
  });

  test("a token with no holes passes through unchanged", () => {
    expect(substituteToken("pkg:IFoo<pkg:IBar>", ["x"])).toBe("pkg:IFoo<pkg:IBar>");
    expect(substituteToken("pkg:IFoo", [])).toBe("pkg:IFoo");
  });

  test("a hole beyond the supplied args throws RangeError", () => {
    expect(() => substituteToken("app/IRepository<$2>", ["only-one"])).toThrow(
      RangeError,
    );
  });
});

// ── substituteSignatures ──────────────────────────────────────────────────────

describe("substituteSignatures", () => {
  test("string token slots are substituted", () => {
    const sigs = substituteSignatures([["app/ILogger<$1>", "app/IDb"]], ["./src/User"]);
    expect(sigs).toEqual([["app/ILogger<./src/User>", "app/IDb"]]);
  });

  test("FactoryRef: type and params are substituted", () => {
    const sigs = substituteSignatures(
      [[{ type: "app/IWidget<$1>", params: ["$1", "app/IStyle"] }]],
      ["./src/Button"],
    );
    expect(sigs).toEqual([
      [{ type: "app/IWidget<./src/Button>", params: ["./src/Button", "app/IStyle"] }],
    ]);
  });

  test("FactoryRef without params stays params-less", () => {
    const sigs = substituteSignatures([[{ type: "app/IWidget<$1>" }]], ["x"]);
    expect(sigs).toEqual([[{ type: "app/IWidget<x>" }]]);
    expect("params" in (sigs[0]![0] as object)).toBe(false);
  });

  test("Union members are substituted recursively (nested unions included)", () => {
    const slot: DepSlot = union("app/ICache<$1>", union("$1", { type: "app/IF<$1>" }));
    const sigs = substituteSignatures([[slot]], ["./src/User"]);
    expect(sigs).toEqual([
      [
        union(
          "app/ICache<./src/User>",
          union("./src/User", { type: "app/IF<./src/User>" }),
        ),
      ],
    ]);
  });

  test("TypeArgRef becomes a LiteralRef carrying the arg's token string", () => {
    const sigs = substituteSignatures(
      [[typeArg(1), typeArg(2)]],
      ["./src/User", "pkg:IList<./src/User>"],
    );
    expect(sigs).toEqual([
      [{ value: "./src/User" }, { value: "pkg:IList<./src/User>" }],
    ]);
  });

  test("TypeArgRef beyond the supplied args throws RangeError", () => {
    expect(() => substituteSignatures([[typeArg(3)]], ["a", "b"])).toThrow(RangeError);
  });

  test("LiteralRef and ScopeRef pass through unchanged (same reference)", () => {
    const literal: DepSlot = { value: "$1" };
    const scope: DepSlot = { scope: true };
    const sigs = substituteSignatures([[literal, scope]], ["x"]);
    expect(sigs[0]![0]).toBe(literal);
    expect(sigs[0]![1]).toBe(scope);
  });

  test("multiple signatures are each substituted", () => {
    const sigs = substituteSignatures(
      [["app/IA<$1>"], ["app/IA<$1>", typeArg(1)]],
      ["x"],
    );
    expect(sigs).toEqual([["app/IA<x>"], ["app/IA<x>", { value: "x" }]]);
  });
});
