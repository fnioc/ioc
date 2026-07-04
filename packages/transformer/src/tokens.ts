// Token generation (PRD §8 "Token generation").
//
// A token is a plain `string` that stably identifies a type across the
// codebase. One rule, no exceptions: every token is `<source>:<exportName>`.
//
//   - `<exportName>` is the type's MODULE-QUALIFIED declared name — the bare
//     name for a top-level type (`IFoo`), dotted for a type nested in a
//     namespace (`A.Foo`). Computed purely from declaration nesting
//     (`symbol.parent` walk), never from the export table.
//
//   - `<source>` is WHERE A HUMAN IMPORTS THE TYPE FROM, in three tiers:
//       1. Importable (package-public) → the exact import specifier: `pkg` for a
//          root export, `pkg/contracts` for a subpath export. Determined from the
//          TypeScript checker EXPORT GRAPH (`getExportsOfModule` over each public
//          entry point), not file-path stems — so a type declared deep but
//          re-exported from the package root tokenizes as the bare `pkg`.
//       2. App-internal (owned by a `package.json` but not publicly exported) →
//          `packageName/<decl-file path relative to package root, ext stripped>`.
//          The package name makes it globally unique.
//       3. Rootless (no named `package.json` up-tree) → best-effort
//          `./<decl-file path relative to projectRoot, ext stripped>`.
//
// The previous "omit the symbol when the file basename matches it" dedup trick
// is retired: a predictable redundant-looking token beats a memorized exception.
//
// The package VERSION is deliberately excluded from the token so that compatible
// versions of a dependency unify on one token. Version-skew caveat: if two
// INCOMPATIBLE versions of the same package are installed, their tokens collide,
// producing a registration conflict (a loud failure) rather than two silently
// isolated containers — the standard semver-peer-dep mitigation applies (keep
// compatible versions). See PRD §8.
//
// `Promise<X>` derives the HONEST closed-generic token `Promise<X>` — Promise-ness
// is part of the type identity (the token-split), NOT unwrapped away. A ctor param
// typed `Promise<IConfig>` depends on the token `Promise<...IConfig>`, and the
// async registration is keyed at that same token.

import ts from "typescript";
import type { Func } from "@rhombus-toolkit/func";

// The unique symbol key name that the Inject brand uses. We look for a property
// named exactly "TOK" on the intersection — the brand is declared as:
//   declare const TOK: unique symbol;
//   type Inject<T, K> = T & { readonly [TOK]?: K };
// At the type level the property key is the symbol, but we cannot refer to the
// symbol across package boundaries. Instead we detect the brand by walking the
// type's properties for one whose declaration is a `readonly [TOK]?: K`
// (computed-symbol property key). The literal string token `K` is what we extract.
//
// A simpler approach: look for a property whose key is a unique symbol AND whose
// type is a string literal. That is unique enough to be the brand in practice.
const INJECT_TOK_PROPERTY = "TOK";

// The unique symbol key name of the `Hole<N, C>` brand (open generics) —
// detected exactly like the Inject brand above, except the extracted literal is
// the NUMBER `N` rather than a token string:
//   declare const HOLE: unique symbol;
//   type Hole<N extends number, C = unknown> = C & { readonly [HOLE]?: N };
const HOLE_BRAND_PROPERTY = "HOLE";

export interface TokenContext {
  readonly checker: ts.TypeChecker;
  /**
   * Project root used ONLY for the rootless best-effort token (a declaration
   * with no owning `package.json` up-tree). App-internal tokens are rendered
   * relative to their owning *package* root, not this directory.
   */
  readonly projectRoot: string;
  /**
   * Reads a file's text for `package.json` discovery, or `undefined` if absent.
   * Defaults to `ts.sys.readFile` in production; the test harness injects a
   * reader that sees its virtual filesystem.
   */
  readonly readFile?: Func<[string], string | undefined>;
  /**
   * Look up a program source file by its EXTENSION-STRIPPED absolute path (its
   * "stem"). Turns a package export entry's on-disk target (e.g.
   * `.../contracts/index.js`) into the declaration file the program actually
   * loaded (`.../contracts/index.d.ts`) so its module exports can be read for
   * package-public detection. Wired inside `createTransformerFactory`; when
   * absent (a hand-built context), package-public detection is skipped and the
   * type falls through to the app-internal / rootless branch.
   */
  readonly sourceFileAtStem?: Func<[string], ts.SourceFile | undefined>;
  /**
   * True when a source file is a TypeScript default lib (`lib.es*.d.ts`).
   * A type declared there tokenizes as its BARE symbol name (`Promise`, `Map`)
   * — the lib path is machine-dependent and carries no identity. Wired to
   * `program.isSourceFileDefaultLibrary` in production; when absent, default-lib
   * symbols fall through to the (nondeterministic) path-based derivation.
   */
  readonly isDefaultLib?: Func<[ts.SourceFile], boolean>;
}

/**
 * Classification of a parameter type for dep extraction. Only `resolvable` is
 * now representable — when no token can be derived the caller is responsible for
 * emitting a hard diagnostic (UnderivableToken). The `hole` variant has been
 * removed; there is no silent fallback.
 */
export type TokenResult = { readonly kind: "resolvable"; readonly token: string };

/**
 * The bare token for an INTRINSIC type — `string`, `number`, `boolean`,
 * `symbol`, `bigint`, `any`, `unknown`, `void`, `never` — derived uniformly from
 * the checker's `intrinsicName` (Rule 1: every named type tokenizes by its
 * name). Returns `undefined` for any non-intrinsic type.
 *
 * Two exclusions keep this from over-matching:
 *   - boolean LITERALS (`true` / `false`) carry the `Intrinsic` flag AND a
 *     `BooleanLiteral` flag with `intrinsicName` `"true"`/`"false"`; those are
 *     singular literals (Rule 2), not the wide `boolean` token, so they are
 *     excluded here and fall through to literal handling.
 *   - `null` / `undefined` / `void` are intrinsic SINGLETONS — exactly one
 *     inhabitant — so they are supplied directly as a `LiteralRef` (Rule 2), not
 *     tokenized. Excluded here so the caller's `singletonValue` path claims them.
 *     `never` (zero inhabitants — nothing to supply) is NOT excluded: it stays a
 *     Rule-1 token `"never"` and simply misses at runtime.
 *
 * Wide `boolean` is modelled by TypeScript as the union `false | true` but still
 * carries the `Intrinsic` flag and `intrinsicName === "boolean"`, so it lands
 * here as the bare token `"boolean"` (NOT the literal-union `"false | true"`).
 */
export function intrinsicToken(type: ts.Type): string | undefined {
  // `TypeFlags.Intrinsic` is not in the public typings (it exists at runtime,
  // value 67359327). The presence of a string `intrinsicName` IS the intrinsic
  // marker — every intrinsic type carries it, no non-intrinsic does — so we read
  // that directly rather than depend on the private flag.
  if (type.flags & ts.TypeFlags.BooleanLiteral) {return undefined;}
  if (
    type.flags &
    (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)
  ) {
    return undefined;
  }
  const name = (type as unknown as { intrinsicName?: unknown }).intrinsicName;
  return typeof name === "string" && name.length ? name : undefined;
}

/**
 * Classify a constructor-parameter type into a token result.
 *
 * Returns `{ kind: "resolvable", token }` when a token can be derived, or
 * `undefined` only for an ANONYMOUS inline structure with no name (a `__type`
 * symbol, or a nameless non-intrinsic type). Every NAMED type tokenizes (Rule
 * 1): each intrinsic — `string`, `number`, `boolean`, `symbol`, `bigint`,
 * `any`, `unknown`, `void`, `never` — yields its keyword as a token, and a
 * literal yields its quoted/rendered token. An unregistered token simply misses
 * at runtime (UnregisteredTokenError); it is NOT a compile error. The caller
 * emits the `UnderivableToken` hard diagnostic only when `undefined` is returned
 * (anonymous structure) and no `Inject` brand is present.
 */
export function tokenForType(
  type: ts.Type,
  ctx: TokenContext,
  failure?: DeriveFailure,
): TokenResult | undefined {
  const token = deriveToken(type, ctx, failure);
  return token === undefined ? undefined : { kind: "resolvable", token };
}

/**
 * Shared property walk for a computed-symbol-keyed "brand" property — the
 * detection strategy behind both `injectTokenFor` (`Inject<T, K>`, brand
 * property `TOK`) and `holeNumberFor` (`Hole<N, C>`, brand property `HOLE`).
 *
 * Walks all properties of `type` (the checker flattens intersections
 * automatically via `getPropertiesOfType`, so a constrained brand like
 * `Entity & { [HOLE]?: 2 }` works) for one declared as a `PropertySignature`
 * whose name is a computed property referencing an identifier matching
 * `propName` — exactly the shape of `declare const TOK: unique symbol; T & {
 * readonly [TOK]?: K }`. The matched property's type is handed to
 * `extractLiteral`, which is responsible for pulling the literal value out
 * (including out of the `K | undefined` union the brand's optionality
 * produces) — the walk itself is brand-agnostic. The first property for which
 * `extractLiteral` returns a defined value wins.
 */
function brandLiteralFor<T>(
  type: ts.Type,
  checker: ts.TypeChecker,
  propName: string,
  extractLiteral: (propType: ts.Type) => T | undefined,
): T | undefined {
  const props = checker.getPropertiesOfType(type);
  for (const prop of props) {
    const decls = prop.getDeclarations();
    // We need the property to be declared as a computed-symbol property. The
    // unique symbol shows up as a symbol-keyed property.
    if (!decls || !decls.length) {continue;}

    // Check if the property name is our unique symbol by looking for a property
    // whose valueDeclaration is a PropertySignature with a computed name referencing
    // a const declaration named `propName`.
    const isBrandProp = decls.some((decl) => {
      if (!ts.isPropertySignature(decl)) {return false;}
      const name = decl.name;
      if (!ts.isComputedPropertyName(name)) {return false;}
      const expr = name.expression;
      if (!ts.isIdentifier(expr)) {return false;}
      return expr.text === propName;
    });
    if (!isBrandProp) {continue;}

    const propType = checker.getTypeOfSymbol(prop);
    const literal = extractLiteral(propType);
    if (literal !== undefined) {return literal;}
  }
  return undefined;
}

/** Pull a string-literal token `K` out of `propType`, or `K | undefined`. */
function extractStringLiteral(propType: ts.Type): string | undefined {
  if (propType.isStringLiteral()) {return propType.value;}
  if (propType.isUnion()) {
    for (const member of propType.types) {
      if (member.isStringLiteral()) {return member.value;}
    }
  }
  return undefined;
}

/** Pull a number-literal token `N` out of `propType`, or `N | undefined`. */
function extractNumberLiteral(propType: ts.Type): number | undefined {
  if (propType.isNumberLiteral()) {return propType.value;}
  if (propType.isUnion()) {
    for (const member of propType.types) {
      if (member.isNumberLiteral()) {return member.value;}
    }
  }
  return undefined;
}

/**
 * Inspect whether `type` carries the `Inject<T, K>` brand and, if so, return
 * the literal string token `K`. Returns `undefined` when the type is not
 * branded.
 *
 * Detection strategy: `brandLiteralFor` walks the type's properties for one
 * that is a unique-symbol keyed optional property whose value type is a
 * string literal. That is exactly the shape of `declare const TOK: unique
 * symbol; T & { readonly [TOK]?: K }`.
 *
 * Union awareness: for a type like `(T & { [TOK]?: K }) | undefined` (which
 * arises from `x?: Inject<T, K>` or `x: Inject<T, K> | undefined`),
 * `getPropertiesOfType` returns only properties common to ALL union members —
 * `undefined` contributes none, so the brand is invisible. We handle this by
 * iterating union constituents, skipping nullish members, and checking each
 * non-nullish member individually. The first branded token found wins.
 */
export function injectTokenFor(
  type: ts.Type,
  checker: ts.TypeChecker,
): string | undefined {
  // Union-aware: if the type is a union, recurse into each non-nullish member.
  // This handles `Inject<T, K> | undefined` (from `x?: Inject<T, K>` or
  // `x: Inject<T, K> | undefined`).
  if (type.isUnion()) {
    for (const member of type.types) {
      const isNullish =
        member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null);
      if (isNullish) {continue;}
      const result = injectTokenFor(member, checker);
      if (result !== undefined) {return result;}
    }
    return undefined;
  }

  return brandLiteralFor(type, checker, INJECT_TOK_PROPERTY, extractStringLiteral);
}

/**
 * If `type` carries the `Hole<N, C>` brand (an open-generic placeholder),
 * return the hole number `N`. Returns `undefined` when the type is not a hole.
 *
 * Detection mirrors `injectTokenFor` exactly via `brandLiteralFor`: walk the
 * type's properties (the checker flattens intersections, so the constrained
 * form `Hole<2, Entity>` — `Entity & { [HOLE]?: 2 }` — works) for one declared
 * as a computed-symbol property named `HOLE`, then extract the number literal
 * from its type. The brand property is optional, so its type is `N |
 * undefined` — the literal is pulled from the union. Works for the anonymous
 * unconstrained form `Hole<1>` (a `__type` with no aliasSymbol) and for
 * aliased/constrained forms alike.
 */
export function holeNumberFor(
  type: ts.Type,
  checker: ts.TypeChecker,
): number | undefined {
  return brandLiteralFor(type, checker, HOLE_BRAND_PROPERTY, extractNumberLiteral);
}

/**
 * The token for an inline function type's RETURN type — the factory's product.
 * Used for factory params (`() => IFoo` → token for `IFoo`). The return type is
 * tokenized honestly: an `async () => IFoo` factory returns `Promise<IFoo>` and
 * derives the token `Promise<...IFoo>` (the token-split — Promise-ness is part of
 * the identity). Returns `undefined` when the return type has no derivable token
 * (e.g. a primitive return), in which case the caller treats the param as a
 * normal hole rather than a factory.
 */
export function tokenForReturnType(
  signature: ts.Signature,
  ctx: TokenContext,
): string | undefined {
  const returnType = ctx.checker.getReturnTypeOfSignature(signature);
  return deriveToken(returnType, ctx);
}

/**
 * Failure channel for `deriveToken` — an `undefined` return alone means
 * "underivable" (990006); when the failure was specifically an UNBOUND type
 * parameter reaching derivation (990007 territory), the field below is set so
 * the caller can emit the sharper diagnostic. Callers that don't care simply
 * omit the argument.
 */
export interface DeriveFailure {
  unboundTypeParameter?: ts.Type;
}

/**
 * Derive the token string for a (already Promise-unwrapped) type. Returns
 * `undefined` for an anonymous structural type with no name (a `__type`
 * symbol or a nameless non-intrinsic) — the caller treats that as the
 * underivable hard-error case — and for an unbound type parameter (reported
 * through `failure` when supplied). Intrinsics tokenize by name (Rule 1);
 * literals by value; a `Hole<N>`-branded type yields `$N`; a GENERIC type
 * reference recurses into its checker-resolved type arguments and renders the
 * canonical closed form `base<arg1,arg2>`.
 */
export function deriveToken(
  type: ts.Type,
  ctx: TokenContext,
  failure?: DeriveFailure,
): string | undefined {
  // Literal types — string / number / boolean / bigint, and unions of them —
  // derive a deterministic token from the literal text itself, enabling
  // literal-level discrimination (`nameof<"a">()`, `add<1 | 2>(...)`,
  // `resolve<"a" | "b">()`).
  const literal = literalToken(type);
  if (literal !== undefined) {return literal;}

  // Rule 1: every intrinsic (string / number / boolean / symbol / bigint / any /
  // unknown / void / never) tokenizes by its name. Wide `boolean` lands here as
  // `"boolean"` (literalToken excludes it). Intrinsics carry no symbol, so this
  // must precede the symbol lookup below.
  const intrinsic = intrinsicToken(type);
  if (intrinsic !== undefined) {return intrinsic;}

  // A Hole-branded placeholder tokenizes as `$N`. Must run BEFORE the
  // alias/symbol derivation — an aliased hole (`type H2 = Hole<2, Entity>`)
  // carries an aliasSymbol that would otherwise mint an alias token, and the
  // unconstrained form (`Hole<1>`) is an anonymous `__type` that would
  // otherwise bail as underivable.
  const hole = holeNumberFor(type, ctx.checker);
  if (hole !== undefined) {return `$${hole}`;}

  // An unbound type parameter has no token — it names a compile-time binding,
  // not a type identity. Report it through the failure channel so callers can
  // emit UnboundTypeParameter (990007) rather than the generic 990006. Checked
  // via the flag (not `isTypeParameter()`) — the predicate's negation would
  // narrow `type` to `never` for the rest of the function.
  if (type.flags & ts.TypeFlags.TypeParameter) {
    if (failure) {failure.unboundTypeParameter = type;}
    return undefined;
  }

  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (!symbol) {return undefined;}

  const name = symbol.getName();
  if (!name || name === "__type") {return undefined;}

  const declaration = primaryDeclaration(symbol);
  if (!declaration) {return undefined;}

  const sourceFile = declaration.getSourceFile();
  const base = baseTokenFor(symbol, sourceFile, ctx);

  // A GENERIC reference appends its checker-resolved type arguments
  // recursively: `base<arg1,arg2>`. Non-generic types return the bare base —
  // exactly the pre-open-generics derivation.
  const typeArguments = genericTypeArguments(type, ctx.checker);
  if (!typeArguments) {return base;}

  const argTokens: string[] = [];
  for (const arg of typeArguments) {
    const argToken = deriveToken(arg, ctx, failure);
    if (argToken === undefined) {return undefined;}
    argTokens.push(argToken);
  }
  return `${base}<${argTokens.join(",")}>`;
}

/**
 * The BASE token `<source>:<exportName>` for a named symbol (sans generic args).
 * `<exportName>` is the module-qualified declared name; `<source>` is one of the
 * three tiers (package-public import specifier, app-internal `pkg/path`, or
 * rootless `./path`). Default-lib types (`Promise`, `Map`) tokenize as the bare
 * symbol name — their lib path is machine-dependent and carries no identity.
 */
function baseTokenFor(
  symbol: ts.Symbol,
  sourceFile: ts.SourceFile,
  ctx: TokenContext,
): string {
  if (ctx.isDefaultLib?.(sourceFile)) {return symbol.getName();}

  const exportName = qualifiedExportName(symbol);
  const declPath = sourceFile.fileName;
  const pkg = nearestPackage(declPath, ctx);
  if (pkg) {
    // Tier 1 — package-public: the exact import specifier from the export graph.
    const spec = publicImportSpecifier(pkg, symbol, ctx);
    if (spec !== undefined) {return `${spec}:${exportName}`;}
    // Tier 2 — app-internal: `packageName/<decl path rel. to package root>`.
    return packagePrivateToken(pkg, declPath, exportName);
  }
  // Tier 3 — rootless: best-effort `./<decl path rel. to projectRoot>`.
  return rootlessToken(declPath, exportName, ctx.projectRoot);
}

/**
 * The module-qualified DECLARED name of a symbol: the bare name for a top-level
 * type (`IFoo`), dotted for a type nested in a namespace/module (`A.Foo`). Walks
 * `symbol.parent` (a private field, accessed via the same narrow cast used for
 * `intrinsicName`) and prepends each enclosing NON-source-file container name.
 * The walk stops at the source-file module symbol, so the file itself never
 * contributes to the name.
 */
function qualifiedExportName(symbol: ts.Symbol): string {
  let name = symbol.getName();
  let parent = symbolParent(symbol);
  while (parent && !isSourceFileModuleSymbol(parent)) {
    name = `${parent.getName()}.${name}`;
    parent = symbolParent(parent);
  }
  return name;
}

/**
 * The outermost declaration ancestor directly owned by a source-file module —
 * `symbol` itself for a top-level type, the enclosing namespace symbol for a
 * type nested inside one. Used to match a type against a module's public exports
 * (a nested type is reachable only through its top-level container).
 */
function topLevelAncestor(symbol: ts.Symbol): ts.Symbol {
  let current = symbol;
  let parent = symbolParent(current);
  while (parent && !isSourceFileModuleSymbol(parent)) {
    current = parent;
    parent = symbolParent(parent);
  }
  return current;
}

/** `symbol.parent` — a private field not in the public typings. */
function symbolParent(symbol: ts.Symbol): ts.Symbol | undefined {
  return (symbol as ts.Symbol & { parent?: ts.Symbol }).parent;
}

/** True when `symbol` is a source-file module (its declaration IS a SourceFile). */
function isSourceFileModuleSymbol(symbol: ts.Symbol): boolean {
  const decls = symbol.getDeclarations();
  return !!decls?.some((d) => ts.isSourceFile(d));
}

/**
 * The type arguments a GENERIC reference was applied with, or `undefined` for
 * a non-generic (or alias-winning) type.
 *
 * Three cases, in order:
 *   - aliasSymbol + aliasTypeArguments → a generic ALIAS applied
 *     (`Wrap<User>`): the alias is the base, its args recurse.
 *   - aliasSymbol with NO aliasTypeArguments → alias-wins (decision 5):
 *     `type UserRepo = IRepository<User>` tokenizes as the bare alias, NO args
 *     — `checker.getTypeArguments` still sees `[User]` underneath, so it must
 *     NOT be consulted here.
 *   - no aliasSymbol → an `ObjectFlags.Reference` type reference
 *     (`IRepository<User>`): `checker.getTypeArguments` (defaults arrive
 *     pre-applied — a bare `IFoo<T = string>` yields `["string"]`).
 */
function genericTypeArguments(
  type: ts.Type,
  checker: ts.TypeChecker,
): readonly ts.Type[] | undefined {
  if (type.aliasSymbol) {
    const args = type.aliasTypeArguments;
    return args?.length ? args : undefined;
  }
  if (
    type.flags & ts.TypeFlags.Object &&
    (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference
  ) {
    const args = checker.getTypeArguments(type as ts.TypeReference);
    return args.length ? args : undefined;
  }
  return undefined;
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
  if (type.isStringLiteral()) {return JSON.stringify(type.value);}
  if (type.isNumberLiteral()) {return String(type.value);}
  if (type.flags & ts.TypeFlags.BigIntLiteral) {
    const value = (type as ts.BigIntLiteralType).value;
    return `${value.negative ? "-" : ""}${value.base10Value}n`;
  }
  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    return (type as unknown as { intrinsicName: string }).intrinsicName;
  }
  return undefined;
}

/** The value payload of a singular (Rule-2) type — may itself be `undefined`/`null`. */
export type LiteralValue = string | number | boolean | bigint | undefined | null;

/**
 * A Rule-2 match: a SINGULAR (non-union) type whose lone value is supplied
 * directly. Wrapped so the `void`/`undefined` case (`value: undefined`) is
 * distinguishable from "not a singular type" (a plain `undefined` return). The
 * caller emits a `LiteralRef` slot from `.value`.
 */
export interface LiteralResult {
  readonly value: LiteralValue;
}

/**
 * Detect a SINGULAR (Rule-2) type and return its value, or `undefined` when the
 * type is not singular. Covers:
 *   - string / number / bigint / boolean LITERALS → the literal's value,
 *   - whole-type `void` / `undefined` → `{ value: undefined }`,
 *   - whole-type `null` → `{ value: null }`.
 * Excludes (returns `undefined`, so the caller tokenizes / strips instead):
 *   - wide `boolean` (`false | true` — a scalar token), and
 *   - any UNION (a literal union stays a token; a nullish union is stripped by
 *     the optional/overload path — this never sees a union as its WHOLE type).
 * `never` is deliberately NOT singular here — it stays a Rule-1 token.
 */
export function singletonValue(type: ts.Type): LiteralResult | undefined {
  if (type.isUnion()) {return undefined;}
  if (type.flags & ts.TypeFlags.Boolean) {return undefined;}
  if (type.isStringLiteral()) {return { value: type.value };}
  if (type.isNumberLiteral()) {return { value: type.value };}
  if (type.flags & ts.TypeFlags.BigIntLiteral) {
    const value = (type as ts.BigIntLiteralType).value;
    return { value: BigInt(`${value.negative ? "-" : ""}${value.base10Value}`) };
  }
  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    return {
      value:
        (type as unknown as { intrinsicName: string }).intrinsicName === "true",
    };
  }
  // Singleton non-literal types: void / undefined → undefined; null → null.
  if (type.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) {
    return { value: undefined };
  }
  if (type.flags & ts.TypeFlags.Null) {return { value: null }; }
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
  if (type.flags & ts.TypeFlags.Boolean) {return undefined;}
  const single = literalText(type);
  if (single !== undefined) {return single;}
  if (type.isUnion()) {
    const parts: string[] = [];
    for (const member of type.types) {
      const text = literalText(member);
      if (text === undefined) {return undefined;}
      parts.push(text);
    }
    return parts.length ? parts.sort().join(" | ") : undefined;
  }
  return undefined;
}

/**
 * For an OPTIONAL pure-literal union (`"a" | "b" | undefined`), the sorted
 * literal-union token over JUST its non-nullish members (`"a" | "b"`), or
 * `undefined` when the type is not such a union. Used so an optional pure-literal
 * param keeps a single discriminated token as the non-nullish part of its
 * union-with-`undefined` fallback, rather than splitting into per-member
 * LiteralRefs. `literalToken` itself can't do this — it rejects the union as soon
 * as the `| undefined` member is present.
 */
export function literalUnionTokenForOptional(type: ts.Type): string | undefined {
  if (!type.isUnion()) {return undefined;}
  const nonNullishMembers = type.types.filter(
    (t) =>
      !(t.flags &
        (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)),
  );
  if (nonNullishMembers.length < 2) {return undefined;}
  // Wide `boolean` is `false | true` internally. After stripping `| undefined`
  // from `boolean | undefined`, the survivors are both BooleanLiterals — which
  // together form the wide boolean scalar. Fall through so `intrinsicToken`
  // yields `"boolean"` instead of the misleading token `"false | true"`.
  if (nonNullishMembers.every((t) => !!(t.flags & ts.TypeFlags.BooleanLiteral))) {
    return undefined;
  }
  const parts: string[] = [];
  for (const member of nonNullishMembers) {
    const text = literalText(member);
    if (text === undefined) {return undefined;}
    parts.push(text);
  }
  return parts.sort().join(" | ");
}

/**
 * True when `type` is a UNION whose every member is a literal (string / number /
 * bigint / boolean literal) — a "pure literal union" like `"a" | "b"` or `1 | 2`.
 * Such a union is a discriminated CHOICE that `literalToken` mints a single sorted
 * token for (`"a" | "b"`), so it stays a resolved token rather than lowering to a
 * `union(...)` of LiteralRef members. Wide `boolean` (the `false | true` union)
 * returns false — it is a scalar token, handled separately.
 */
export function isPureLiteralUnion(type: ts.Type): boolean {
  if (type.flags & ts.TypeFlags.Boolean) {return false;}
  if (!type.isUnion()) {return false;}
  return type.types.every((member) => literalText(member) !== undefined);
}

/** The declaration we anchor a token on — prefer interface/class/type-alias. */
function primaryDeclaration(symbol: ts.Symbol): ts.Declaration | undefined {
  const decls = symbol.getDeclarations();
  if (!decls || !decls.length) {return undefined;}
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
      if (cached) {return cached;}
    } else {
      const pkgPath = `${dir}/package.json`;
      const text = read(pkgPath);
      let resolved: PackageInfo | null = null;
      if (text !== undefined) {
        try {
          const json = JSON.parse(text) as PackageJson;
          if (typeof json.name === "string" && json.name.length) {
            resolved = { name: json.name, dir, json };
          }
        } catch {
          // Malformed package.json — treat as absent and keep walking up.
        }
      }
      cache.set(dir, resolved);
      if (resolved) {return resolved;}
    }
    const parent = dirname(dir);
    if (parent === dir) {return undefined;}
    dir = parent;
  }
}

/**
 * If `symbol` is reachable through `pkg`'s PUBLIC exports, return the exact
 * import specifier a consumer writes — `pkg` for a root export, `pkg/contracts`
 * for a subpath export. Returns `undefined` when the type is private to the
 * package (→ app-internal token).
 *
 * The match is against the checker EXPORT GRAPH, not file-path stems: each
 * public entry point's module is resolved (via `sourceFileAtStem`) and its
 * `getExportsOfModule` is scanned (aliases resolved) for a symbol that SHARES A
 * DECLARATION with the type's top-level ancestor. This resolves a type declared
 * deep but re-exported from the package root to the bare package — something
 * stem matching could never do.
 *
 * Canonical pick among matching subpaths (deterministic):
 *   1. Prefer the entry whose target module IS the declaration's own file.
 *   2. Else the shortest subpath (root `""` wins → bare package), ties broken
 *      lexicographically.
 */
function publicImportSpecifier(
  pkg: PackageInfo,
  symbol: ts.Symbol,
  ctx: TokenContext,
): string | undefined {
  if (!ctx.sourceFileAtStem) {return undefined;}
  const target = topLevelAncestor(symbol);
  const targetDecls = new Set(target.getDeclarations() ?? []);
  if (!targetDecls.size) {return undefined;}
  const declFile = primaryDeclaration(target)?.getSourceFile();

  const matches: { subpath: string; targetsDeclFile: boolean }[] = [];
  for (const entry of collectExportEntries(pkg)) {
    const absStem = stripExt(`${pkg.dir}/${entry.targetRel}`);
    const sf = ctx.sourceFileAtStem(absStem);
    if (!sf) {continue;}
    const mod = ctx.checker.getSymbolAtLocation(sf);
    if (!mod) {continue;}
    for (const exp of ctx.checker.getExportsOfModule(mod)) {
      const resolved =
        exp.flags & ts.SymbolFlags.Alias
          ? ctx.checker.getAliasedSymbol(exp)
          : exp;
      const decls = resolved.getDeclarations() ?? [];
      if (decls.some((d) => targetDecls.has(d))) {
        matches.push({ subpath: entry.subpath, targetsDeclFile: sf === declFile });
        break;
      }
    }
  }
  if (!matches.length) {return undefined;}

  matches.sort((a, b) => {
    if (a.targetsDeclFile !== b.targetsDeclFile) {
      return a.targetsDeclFile ? -1 : 1;
    }
    if (a.subpath.length !== b.subpath.length) {
      return a.subpath.length - b.subpath.length;
    }
    return a.subpath < b.subpath ? -1 : a.subpath > b.subpath ? 1 : 0;
  });
  const best = matches[0]!;
  return best.subpath === "" ? pkg.name : `${pkg.name}/${best.subpath}`;
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
        for (const key of keys) {pushTarget(key, obj[key]);}
      } else {
        // A bare conditions object at the top level == the root entry.
        pushTarget(".", obj);
      }
    }
  }

  // Fallbacks broaden the public surface (a package may ship `main`/`types`
  // without an `exports` map, or alongside a root-only `exports`).
  for (const field of [json.main, json.module, json.types, json.typings]) {
    if (typeof field === "string" && field.length) {
      out.push({ subpath: "", targetRel: field.replace(/^\.\/?/, "") });
    }
  }
  if (!out.length) {
    // No declared surface at all → treat the conventional `index` as public.
    out.push({ subpath: "", targetRel: "index" });
  }
  return out;
}

/** Resolve an exports condition value to its concrete string target(s). */
function resolveConditionTargets(target: unknown): string[] {
  if (typeof target === "string") {return [target];}
  if (typeof target === "object" && target !== null) {
    const obj = target as Record<string, unknown>;
    const out: string[] = [];
    // Prefer the import/types/default channels; collect all string leaves.
    for (const key of ["types", "import", "module", "default", "require", "node", "bun"]) {
      const v = obj[key];
      if (typeof v === "string") {out.push(v);}
      else if (typeof v === "object" && v !== null) {out.push(...resolveConditionTargets(v));}
    }
    return out;
  }
  return [];
}

// ── path helpers (POSIX-normalized; the harness uses `/` virtual paths) ──────

function posixRelative(from: string, to: string): string | undefined {
  const a = normalize(from).replace(/\/$/, "");
  const b = normalize(to);
  if (b === a) {return "";}
  if (b.startsWith(a + "/")) {return b.slice(a.length + 1);}
  return undefined;
}

function normalize(p: string): string {
  return p.replace(/\\/g, "/");
}

/** POSIX dirname over a normalized path; returns the input when at the root. */
function dirname(p: string): string {
  const n = normalize(p).replace(/\/+$/, "");
  const idx = n.lastIndexOf("/");
  if (idx <= 0) {return idx === 0 ? "/" : n;}
  return n.slice(0, idx);
}

export function stripExt(p: string): string {
  return p
    .replace(/\.d\.ts$/, "")
    .replace(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, "");
}

/**
 * App-internal (tier 2) token: `packageName/<decl-file path relative to the
 * PACKAGE root, extension stripped>:<exportName>`. The package-name prefix makes
 * it globally unique across disparate packages that share a relative path.
 */
function packagePrivateToken(
  pkg: PackageInfo,
  declPath: string,
  exportName: string,
): string {
  const rel = posixRelative(pkg.dir, declPath);
  const base = stripExt(rel ?? normalize(declPath).replace(/^\/+/, ""));
  return `${pkg.name}/${base}:${exportName}`;
}

/**
 * Rootless (tier 3) token: best-effort `./<decl-file path relative to the
 * project root, extension stripped>:<exportName>` for a declaration with no
 * owning `package.json` up-tree — no package name to qualify with. When the
 * declaration is outside the project root, the absolute path (leading `/`
 * stripped so `./` doesn't double the slash) stands in.
 */
function rootlessToken(
  declPath: string,
  exportName: string,
  projectRoot: string,
): string {
  const rel = posixRelative(projectRoot, declPath);
  const base = stripExt(rel ?? normalize(declPath).replace(/^\/+/, ""));
  return `./${base}:${exportName}`;
}
