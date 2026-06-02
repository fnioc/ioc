// Token generation (PRD §8 "Token generation").
//
// A token is a plain `string` that stably identifies an interface across the
// codebase. There are two derivations:
//
//   1. Package-public type — reachable through a package's PUBLIC exports:
//        `packageName:publicExportSubpath/SymbolName`   e.g. `your-lib:contracts/IFoo`
//      We find the owning package by walking up to the nearest `package.json`
//      from the type's declaration file, then check the package's
//      `exports`/`main` to decide public-export status + the subpath.
//
//   2. App-internal type — not publicly exported:
//        a source-relative path token                   e.g. `./src/services/IUserRepo`
//
// The package VERSION is deliberately excluded from the token so that compatible
// versions of a dependency unify on one token. Version-skew caveat: if two
// INCOMPATIBLE versions of the same package are installed, their tokens collide,
// producing a registration conflict (a loud failure) rather than two silently
// isolated containers — the standard semver-peer-dep mitigation applies (keep
// compatible versions). See PRD §8.
//
// `Promise<X>` unwraps to the token for `X`: Promise-ness is a property of the
// registration's factory, not a separate token.

import ts from "typescript";
import type { Func } from "@rhombus-toolkit/func";

export interface TokenContext {
  readonly checker: ts.TypeChecker;
  /**
   * Project root used to make app-internal tokens source-relative. Tokens for
   * app-internal types are rendered relative to this directory and prefixed
   * with `./`.
   */
  readonly projectRoot: string;
  /**
   * Reads a file's text for `package.json` discovery, or `undefined` if absent.
   * Defaults to `ts.sys.readFile` in production; the test harness injects a
   * reader that sees its virtual filesystem.
   */
  readonly readFile?: Func<[string], string | undefined>;
}

/**
 * Classification of a parameter type for dep extraction. A `hole` type can
 * never be a token (primitive / `any` / `unknown` / `void`) and lowers to
 * `null`; a `resolvable` type lowers to its string token.
 */
export type TokenResult =
  | { readonly kind: "hole" }
  | { readonly kind: "resolvable"; readonly token: string };

/** Unwrap a single `Promise<X>` layer, returning `X`'s type (or the input). */
function unwrapPromise(type: ts.Type, checker: ts.TypeChecker): ts.Type {
  const symbol = type.getSymbol();
  if (symbol?.getName() === "Promise") {
    const ref = type as ts.TypeReference;
    const args = checker.getTypeArguments(ref);
    if (args.length === 1) return args[0]!;
  }
  return type;
}

/**
 * Classify a constructor-parameter type into a hole or a token. Unwraps a
 * single `Promise<X>` layer first.
 *
 * There is NO pre-emptive "primitive → hole" mask: the type is looked up exactly
 * as written, and a slot is a hole ONLY when its type is unresolvable — i.e.
 * `deriveToken` finds no token (a wide primitive / top / bottom type has no
 * symbol, an anonymous structural type has no name). A literal type IS a token
 * (`"dev"` → `"dev"`), since it resolves. This mirrors the manual surface, where
 * a hole is something the author marks explicitly, never something inferred from
 * a parameter being "primitive-shaped".
 */
export function tokenForType(type: ts.Type, ctx: TokenContext): TokenResult {
  const unwrapped = unwrapPromise(type, ctx.checker);
  const token = deriveToken(unwrapped, ctx);
  return token === undefined
    ? { kind: "hole" }
    : { kind: "resolvable", token };
}

/**
 * The token for an inline function type's RETURN type — the factory's product.
 * Used for factory params (`() => IFoo` → token for `IFoo`). Unwraps a single
 * `Promise<X>` layer exactly as the normal path does (an `async () => IFoo`
 * factory returns `Promise<IFoo>`). Returns `undefined` when the return type has
 * no derivable token (e.g. a primitive return), in which case the caller treats
 * the param as a normal hole rather than a factory.
 */
export function tokenForReturnType(
  signature: ts.Signature,
  ctx: TokenContext,
): string | undefined {
  const returnType = ctx.checker.getReturnTypeOfSignature(signature);
  const unwrapped = unwrapPromise(returnType, ctx.checker);
  return deriveToken(unwrapped, ctx);
}

/**
 * Derive the token string for a (already Promise-unwrapped, non-primitive)
 * type. Returns `undefined` when no declaration with a name is reachable (an
 * anonymous / structural type with no symbol — treated as a hole by the caller).
 */
export function deriveToken(
  type: ts.Type,
  ctx: TokenContext,
): string | undefined {
  // Literal types — string / number / boolean / bigint, and unions of them —
  // derive a deterministic token from the literal text itself, enabling
  // literal-level discrimination (`nameof<"a">()`, `add<1 | 2>(...)`,
  // `resolve<"a" | "b">()`).
  const literal = literalToken(type);
  if (literal !== undefined) return literal;

  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (!symbol) return undefined;

  const name = symbol.getName();
  if (!name || name === "__type") return undefined;

  const declaration = primaryDeclaration(symbol);
  if (!declaration) return undefined;

  const sourceFile = declaration.getSourceFile();
  const declPath = sourceFile.fileName;

  const pkg = nearestPackage(declPath, ctx);
  if (pkg) {
    const subpath = publicExportSubpath(pkg, declPath);
    if (subpath !== undefined) {
      // Package-public: `name:subpath/Symbol` (subpath "" → `name:Symbol`).
      return subpath === ""
        ? `${pkg.name}:${name}`
        : `${pkg.name}:${subpath}/${name}`;
    }
  }

  // App-internal: source-relative path token, `./`-prefixed, no extension.
  return appInternalToken(declPath, name, ctx.projectRoot);
}

/**
 * Render a SINGLE literal type as its valid-TS text, or `undefined` if the type
 * is not a renderable literal. Covers every literal kind we can stably stringify:
 *   - string  → `"a"` (JSON-quoted)
 *   - number  → `42`
 *   - bigint  → `123n`
 *   - boolean → `true` / `false`
 * Enum members carry the underlying string/number-literal flag, so they render
 * by their value here. Template-literal types and `unique symbol` have no fixed
 * value and return `undefined` (they fall through to symbol-based derivation).
 */
function literalText(type: ts.Type): string | undefined {
  if (type.isStringLiteral()) return JSON.stringify(type.value);
  if (type.isNumberLiteral()) return String(type.value);
  if (type.flags & ts.TypeFlags.BigIntLiteral) {
    const value = (type as ts.BigIntLiteralType).value;
    return `${value.negative ? "-" : ""}${value.base10Value}n`;
  }
  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    return (type as unknown as { intrinsicName: string }).intrinsicName;
  }
  return undefined;
}

/**
 * A deterministic token for a literal type or a union of literal types. Members
 * are rendered as valid TS (see `literalText`), SORTED (so member order is
 * irrelevant), and ` | `-joined — e.g. `"asdf" | "qwer"`, `1 | 2`, `false | true`.
 * Returns `undefined` for any type that is not a literal / pure-literal union, so
 * non-literal types fall through to the symbol-based derivation. Governs every
 * token position uniformly — nameof / add / resolve AND ctor/factory params — so
 * a `mode: "dev"` param and an `add<"dev">(…)` registration unify on one token.
 *
 * Wide `boolean` is explicitly excluded: TypeScript models it as the union
 * `false | true`, which would otherwise mint the bogus token `"false | true"`
 * for a plain boolean param. A boolean is a scalar (a hole), not a discriminant;
 * an intentional `true` / `false` LITERAL still resolves (it carries
 * `BooleanLiteral`, not the wide `Boolean` flag).
 */
function literalToken(type: ts.Type): string | undefined {
  if (type.flags & ts.TypeFlags.Boolean) return undefined;
  const single = literalText(type);
  if (single !== undefined) return single;
  if (type.isUnion()) {
    const parts: string[] = [];
    for (const member of type.types) {
      const text = literalText(member);
      if (text === undefined) return undefined;
      parts.push(text);
    }
    return parts.length > 0 ? parts.sort().join(" | ") : undefined;
  }
  return undefined;
}

/** The declaration we anchor a token on — prefer interface/class/type-alias. */
function primaryDeclaration(symbol: ts.Symbol): ts.Declaration | undefined {
  const decls = symbol.getDeclarations();
  if (!decls || decls.length === 0) return undefined;
  const preferred = decls.find(
    (d) =>
      ts.isInterfaceDeclaration(d) ||
      ts.isClassDeclaration(d) ||
      ts.isTypeAliasDeclaration(d) ||
      ts.isEnumDeclaration(d),
  );
  return preferred ?? decls[0];
}

// ── package.json discovery + public-export resolution ────────────────────────

interface PackageInfo {
  readonly name: string;
  readonly dir: string;
  readonly json: PackageJson;
}

interface PackageJson {
  name?: string;
  main?: string;
  module?: string;
  types?: string;
  typings?: string;
  exports?: unknown;
}

// Per-context cache: keyed by the TokenContext so distinct programs (e.g.
// separate test fixtures sharing a `/virtual` dir with different package.json
// contents) never cross-contaminate.
const packageCaches = new WeakMap<TokenContext, Map<string, PackageInfo | null>>();

function cacheFor(ctx: TokenContext): Map<string, PackageInfo | null> {
  let cache = packageCaches.get(ctx);
  if (!cache) {
    cache = new Map();
    packageCaches.set(ctx, cache);
  }
  return cache;
}

/** Walk up from `fromPath` to the nearest readable, named `package.json`. */
function nearestPackage(
  fromPath: string,
  ctx: TokenContext,
): PackageInfo | undefined {
  const read = ctx.readFile ?? ts.sys.readFile;
  const cache = cacheFor(ctx);
  let dir = dirname(fromPath);
  // The nearest named package.json wins — that's the package that owns the
  // declaration.
  for (;;) {
    const cached = cache.get(dir);
    if (cached !== undefined) {
      if (cached) return cached;
    } else {
      const pkgPath = `${dir}/package.json`;
      const text = read(pkgPath);
      let resolved: PackageInfo | null = null;
      if (text !== undefined) {
        try {
          const json = JSON.parse(text) as PackageJson;
          if (typeof json.name === "string" && json.name.length > 0) {
            resolved = { name: json.name, dir, json };
          }
        } catch {
          // Malformed package.json — treat as absent and keep walking up.
        }
      }
      cache.set(dir, resolved);
      if (resolved) return resolved;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * If `declPath` is reachable through `pkg`'s public exports, return the export
 * SUBPATH (the public entry's directory relative to the package root, sans
 * extension; `""` for the root entry). Returns `undefined` when the file is
 * private to the package (not its `main`/`exports`/`types` surface).
 */
function publicExportSubpath(
  pkg: PackageInfo,
  declPath: string,
): string | undefined {
  const rel = posixRelative(pkg.dir, declPath);
  if (rel === undefined) return undefined;
  const relNoExt = stripExt(rel);

  const entries = collectExportEntries(pkg);

  // A `.d.ts` declaration commonly pairs with a `.js` entry of the same stem,
  // and a directory entry pairs with its `/index`.
  for (const entry of entries) {
    const entryNoExt = stripExt(entry.targetRel);
    if (
      entryNoExt === relNoExt ||
      entryNoExt.replace(/\/index$/, "") === relNoExt.replace(/\/index$/, "")
    ) {
      return entry.subpath;
    }
  }
  return undefined;
}

interface ExportEntry {
  /** Public subpath: `""` for the root, else e.g. `contracts`. */
  readonly subpath: string;
  /** The on-disk target, relative to the package dir (sans leading `./`). */
  readonly targetRel: string;
}

/**
 * Flatten a package's public entry points into `(subpath, targetRel)` pairs.
 * Reads `exports` (string / conditions / subpath map) and falls back to
 * `main` / `module` / `types`. A subpath of `"."` maps to the empty public
 * subpath; deeper subpaths drop the leading `./`.
 */
function collectExportEntries(pkg: PackageInfo): ExportEntry[] {
  const out: ExportEntry[] = [];
  const { json } = pkg;

  const pushTarget = (subKey: string, target: unknown): void => {
    const targets = resolveConditionTargets(target);
    const subpath = subKey === "." ? "" : subKey.replace(/^\.\/?/, "");
    for (const t of targets) {
      out.push({ subpath, targetRel: t.replace(/^\.\/?/, "") });
    }
  };

  if (json.exports !== undefined && json.exports !== null) {
    const exp = json.exports;
    if (typeof exp === "string") {
      pushTarget(".", exp);
    } else if (typeof exp === "object") {
      const obj = exp as Record<string, unknown>;
      const keys = Object.keys(obj);
      const looksLikeSubpathMap = keys.some((k) => k === "." || k.startsWith("./"));
      if (looksLikeSubpathMap) {
        for (const key of keys) pushTarget(key, obj[key]);
      } else {
        // A bare conditions object at the top level == the root entry.
        pushTarget(".", obj);
      }
    }
  }

  // Fallbacks broaden the public surface (a package may ship `main`/`types`
  // without an `exports` map, or alongside a root-only `exports`).
  for (const field of [json.main, json.module, json.types, json.typings]) {
    if (typeof field === "string" && field.length > 0) {
      out.push({ subpath: "", targetRel: field.replace(/^\.\/?/, "") });
    }
  }
  if (out.length === 0) {
    // No declared surface at all → treat the conventional `index` as public.
    out.push({ subpath: "", targetRel: "index" });
  }
  return out;
}

/** Resolve an exports condition value to its concrete string target(s). */
function resolveConditionTargets(target: unknown): string[] {
  if (typeof target === "string") return [target];
  if (target && typeof target === "object") {
    const obj = target as Record<string, unknown>;
    const out: string[] = [];
    // Prefer the import/types/default channels; collect all string leaves.
    for (const key of ["types", "import", "module", "default", "require", "node", "bun"]) {
      const v = obj[key];
      if (typeof v === "string") out.push(v);
      else if (v && typeof v === "object") out.push(...resolveConditionTargets(v));
    }
    return out;
  }
  return [];
}

// ── path helpers (POSIX-normalized; the harness uses `/` virtual paths) ──────

function posixRelative(from: string, to: string): string | undefined {
  const a = normalize(from).replace(/\/$/, "");
  const b = normalize(to);
  if (b === a) return "";
  if (b.startsWith(a + "/")) return b.slice(a.length + 1);
  return undefined;
}

function normalize(p: string): string {
  return p.replace(/\\/g, "/");
}

/** POSIX dirname over a normalized path; returns the input when at the root. */
function dirname(p: string): string {
  const n = normalize(p).replace(/\/+$/, "");
  const idx = n.lastIndexOf("/");
  if (idx <= 0) return idx === 0 ? "/" : n;
  return n.slice(0, idx);
}

function stripExt(p: string): string {
  return p
    .replace(/\.d\.ts$/, "")
    .replace(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, "");
}

/**
 * Source-relative token for an app-internal declaration: the declaration file's
 * path relative to the project root, `./`-prefixed, extension stripped. Per the
 * PRD §8 example `./src/services/IUserRepo`, the file path IS the identity when
 * the file is named after the symbol it declares. To stay collision-safe when a
 * file declares multiple interfaces, the SymbolName is appended only when the
 * file's basename differs from it — so `src/services/IUserRepo.ts` →
 * `./src/services/IUserRepo`, but `src/types.ts` declaring `IFoo` →
 * `./src/types/IFoo`.
 */
function appInternalToken(
  declPath: string,
  name: string,
  projectRoot: string,
): string {
  // When the declaration is not under the project root (no rootDir, or a path
  // outside it), fall back to the absolute path with its leading `/` stripped so
  // the `./` prefix doesn't produce a doubled slash (`.//tmp/...`).
  const rel = posixRelative(projectRoot, declPath);
  const base = stripExt(rel ?? normalize(declPath).replace(/^\/+/, ""));
  const basename = base.slice(base.lastIndexOf("/") + 1);
  return basename === name ? `./${base}` : `./${base}/${name}`;
}
