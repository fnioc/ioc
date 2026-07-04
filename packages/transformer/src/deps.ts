// Constructor dependency extraction (PRD §8 "Dep extraction"; §7 factories).
//
// Given a concrete class's constructor, read each parameter's type via the
// TypeChecker and compute one slot per parameter:
//   - Inject<T, "tok"> branded param       →  the branded token string
//   - `Promise<X>`                          →  the token for `X`
//   - an inline function type `() => IFoo` →  a factory ref { type: token-of-IFoo }
//   - an inline union `A | B`              →  a UnionSlot { union: [slotA, slotB] }
//   - a SINGULAR literal `"dev"` / `42`    →  a LiteralSlot { value } (Rule 2)
//   - everything else                      →  a string token
//   - anonymous structure with no brand    →  hard diagnostic (UnderivableToken)
// The result is ONE signature (a positional array), matching the single
// canonical ctor the transformer sees statically.

import ts from "typescript";
import {
  tokenForType,
  tokenForReturnType,
  injectTokenFor,
  holeNumberFor,
  deriveToken,
  isPureLiteralUnion,
  literalUnionTokenForOptional,
  singletonValue,
  type DeriveFailure,
  type LiteralValue,
  type TokenContext,
} from "./tokens.js";
import {
  DiagnosticCode,
  error,
  type DiagnosticSink,
} from "./diagnostics.js";

/**
 * A factory slot in an extracted signature — the transformer's in-memory mirror
 * of the runtime `FactoryRef` shape. Emitted as `{ type: "<token>" }` (or
 * `{ type: "<token>", params: [...] }` when params are present) in the inline
 * signature array (the registration's third argument).
 */
export interface FactorySlot {
  readonly type: string;
  readonly params?: readonly string[];
}

/**
 * A scope slot — the transformer's in-memory mirror of the runtime `ScopeRef`.
 * Emitted as a `{ scope: true }` object literal. Produced for a parameter whose
 * type is `ResolveScope`: the engine fills it with the live resolution scope.
 */
export interface ScopeSlot {
  readonly scope: true;
}

/**
 * A union slot — the transformer's in-memory mirror of the runtime `Union` shape.
 * Produced when a parameter's type annotation is an inline union type node
 * (`A | B`), NOT a named type alias referencing a union. Emitted as
 * `{ union: [slotA, slotB, ...] }` in the inline signature array.
 * Detection is purely syntactic (the annotation node shape).
 */
export interface UnionSlot {
  readonly union: readonly Slot[];
}

/**
 * A literal slot — the transformer's in-memory mirror of the runtime
 * `LiteralRef`. Produced for a SINGULAR (Rule-2) parameter: a literal (`"dev"`,
 * `42`, `true`, `1n`) OR a whole-type `void`/`undefined`/`null`. The value is
 * supplied directly, no container lookup. Emitted as `{ value: ... }` in the
 * inline signature array. A literal/nullish UNION (`"a" | "b"`,
 * `Foo | undefined`) is NOT a literal slot. `value` may itself be `undefined`,
 * so the slot is identified by the PRESENCE of the `value` key.
 */
export interface LiteralSlot {
  readonly value: LiteralValue;
}

/**
 * A type-arg slot — the transformer's in-memory mirror of the runtime
 * `TypeArgRef`. Produced for a parameter typed `Typeof<T>` where `T` is
 * bound to a Hole: the parameter receives the TOKEN STRING of the
 * registration's `typeArg`th type argument (1-based). Emitted as
 * `{ typeArg: N }` in the registration-carried signature array; substitution
 * closes it into a literal value slot per closing. A CONCRETE binding emits a
 * `LiteralSlot` with the derived token directly instead.
 */
export interface TypeArgSlot {
  readonly typeArg: number;
}

/**
 * One positional slot: a token string, a factory ref, a scope ref, a union of
 * alternatives, a literal value, or a type-arg ref. There is no `null` / hole
 * sentinel — an unresolvable (anonymous-structure) type causes a hard compile
 * error (`UnderivableToken`).
 */
export type Slot =
  | string
  | FactorySlot
  | ScopeSlot
  | UnionSlot
  | LiteralSlot
  | TypeArgSlot;

/** One emitted signature: positional slots (token / factory / scope / union / literal). */
export type Signature = readonly Slot[];

/** True when a slot is a factory ref rather than a plain token / scope / union. */
export function isFactorySlot(slot: Slot): slot is FactorySlot {
  return (
    typeof slot === "object" &&
    typeof (slot as { type?: unknown }).type === "string"
  );
}

/** True when a slot is a scope ref (`{ scope: true }`). */
export function isScopeSlot(slot: Slot): slot is ScopeSlot {
  return (
    typeof slot === "object" &&
    (slot as { scope?: unknown }).scope === true
  );
}

/** True when a slot is a union of alternatives (`{ union: [...] }`). */
export function isUnionSlot(slot: Slot): slot is UnionSlot {
  return (
    typeof slot === "object" &&
    Array.isArray((slot as { union?: unknown }).union)
  );
}

/**
 * True when a slot is a literal-value slot (`{ value: ... }`). Identified by the
 * PRESENCE of the `value` key — `value` may legitimately be `undefined` (the
 * `void`/`undefined` Rule-2 case), so a `typeof`/`!== undefined` check would
 * miss it.
 */
export function isLiteralSlot(slot: Slot): slot is LiteralSlot {
  return typeof slot === "object" && "value" in slot;
}

/**
 * True when a slot is a type-arg ref (`{ typeArg: N }`). Key-disjoint from
 * every other slot kind, so the numeric check is sufficient.
 */
export function isTypeArgSlot(slot: Slot): slot is TypeArgSlot {
  return (
    typeof slot === "object" &&
    typeof (slot as { typeArg?: unknown }).typeArg === "number"
  );
}

/**
 * Structural equality for slots. Two slots are equal when:
 *   - both are the same string token
 *   - both are factory refs with the same type and params
 *   - both are scope refs
 *   - both are union slots with element-wise equal members (recursive)
 *   - both are literal slots with strictly-equal values
 *   - both are type-arg refs with the same hole number
 */
export function slotsEqual(a: Slot, b: Slot): boolean {
  if (a === b) {return true;}
  if (typeof a === "string" || typeof b === "string") {return false;}
  if (isScopeSlot(a) && isScopeSlot(b)) {return true;}
  if (isTypeArgSlot(a) && isTypeArgSlot(b)) {return a.typeArg === b.typeArg;}
  if (isFactorySlot(a) && isFactorySlot(b)) {
    if (a.type !== b.type) {return false;}
    const ap = a.params ?? [];
    const bp = b.params ?? [];
    if (ap.length !== bp.length) {return false;}
    return ap.every((p, i) => p === bp[i]);
  }
  if (isUnionSlot(a) && isUnionSlot(b)) {
    if (a.union.length !== b.union.length) {return false;}
    return a.union.every((s, i) => slotsEqual(s, b.union[i]!));
  }
  if (isLiteralSlot(a) && isLiteralSlot(b)) {return a.value === b.value;}
  return false;
}

/**
 * The name of the runtime scope-contract interface. A parameter typed
 * `ResolveScope` becomes a `ScopeSlot` (the live scope is injected) rather than
 * a token. Matched by symbol name — a user interface of the same name is
 * treated as the scope contract, mirroring the `nameof` / factory heuristics.
 */
const RESOLVE_SCOPE_NAME = "ResolveScope";

/**
 * The name of the `Typeof<T>` brand alias (the `typeof(T)` analog for
 * open generics). Matched by alias/symbol name — same convention as
 * `ResolveScope` above. The binding `T` is read from `aliasTypeArguments[0]`.
 */
const TYPE_ARG_TOKEN_NAME = "Typeof";

export interface ConstructorExtraction {
  /** The class symbol the constructor belongs to. */
  readonly classSymbol: ts.Symbol;
  /**
   * The extracted signatures: one per DECLARED ctor overload, or a single
   * signature from the implementation when no overloads are declared (optional
   * params become union-with-`undefined`-fallback slots, not extra signatures).
   */
  readonly signatures: Signature[];
}

/**
 * Context required by dep-extraction helpers that emit diagnostics.
 * Extends TokenContext with the diagnostic sink and anchor source file.
 */
export interface DepContext extends TokenContext {
  readonly sink: DiagnosticSink;
  readonly sourceFile: ts.SourceFile;
}

/**
 * Resolve the class a registration's concrete-argument expression refers to and
 * extract its constructor signature. Returns `undefined` when the expression
 * does not statically resolve to a class with a declaration (a dynamic
 * registration — the caller emits no dep array and warns).
 */
export function extractFromExpression(
  expr: ts.Expression,
  ctx: DepContext,
): ConstructorExtraction | undefined {
  const symbol = ctx.checker.getSymbolAtLocation(expr);
  const resolved = symbol && aliasTarget(symbol, ctx.checker);
  if (!resolved) {return undefined;}

  const classDecl = classDeclarationOf(resolved);
  if (!classDecl) {return undefined;}

  const signatures = extractSignatureFromClass(classDecl, ctx);
  return { classSymbol: resolved, signatures };
}

/** Follow import aliases to the symbol's real declaration target. */
function aliasTarget(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

/** The class declaration backing a symbol, if any. */
function classDeclarationOf(symbol: ts.Symbol): ts.ClassDeclaration | undefined {
  const decls = symbol.getDeclarations();
  return decls?.find(ts.isClassDeclaration);
}

/**
 * Extract the constructor signatures from a class declaration.
 *
 *   - DECLARED overloads (bodyless ctor declarations preceding the
 *     implementation) are honored AS-IS: one emitted signature per declared
 *     overload, in declaration order, with the implementation signature ignored
 *     entirely (TS hides the impl from callers — so do we). Each overload's
 *     params run the normal per-param rules (incl. the optional-union fallback).
 *   - No declared overloads → the implementation signature drives extraction,
 *     yielding exactly ONE signature (union-unification, no overload expansion).
 *   - No explicit constructor (or a zero-param one) → a single empty signature.
 *
 * Parameter properties / modifiers are irrelevant — only param TYPES drive
 * token derivation.
 */
export function extractSignatureFromClass(
  classDecl: ts.ClassDeclaration,
  ctx: DepContext,
): Signature[] {
  const ctors = classDecl.members.filter(ts.isConstructorDeclaration);
  if (!ctors.length) {return [[]];}

  // Bodyless overload declarations, if any, are the caller-visible signatures.
  const declaredOverloads = ctors.filter((c) => c.body === undefined);
  if (declaredOverloads.length) {
    return declaredOverloads.map((ctor) =>
      ctor.parameters.map((param) => extractParamSlot(param, ctx)),
    );
  }

  // No declared overloads → the implementation signature drives (one signature).
  return paramsToSignatures(ctors[0]!.parameters, ctx);
}

/**
 * Map a parameter list to its emitted signatures. Auto-extraction always yields
 * exactly ONE signature — one slot per param, no overload expansion.
 *
 * Optionality is handled PER-PARAM, not by suffix-dropping: any optional param
 * (`x?: X`, `x: X = default`, `x: X | undefined`/`| void`) lowers to a
 * `union(<non-nullish slots>, { value: undefined })` whose LiteralRef fallback is
 * LAST, so the real dependency wins when registered and `undefined` is supplied
 * otherwise (see `extractParamSlot`). This is strictly more expressive than
 * trailing-overload expansion, which can't represent `(a?: X unresolvable, b?: Y
 * registered)` — expansion degrades to `[]` and loses `b`, whereas the per-param
 * union yields `new Ctor(undefined, y)`. JS makes an explicit `undefined`
 * argument equivalent to omission for a default initializer, so `= default`
 * still fires. The signature array stays a `Token[][]` (an array of signatures)
 * even though the transformer now emits exactly one.
 */
function paramsToSignatures(
  params: readonly ts.ParameterDeclaration[],
  ctx: DepContext,
): Signature[] {
  return [params.map((param) => extractParamSlot(param, ctx))];
}

/**
 * Classify a single constructor parameter into a slot.
 *
 * Priority order:
 *   1. `ResolveScope`-typed → ScopeSlot (live scope injection).
 *   2. `Inject<T, "tok">` brand on the type → the branded token string.
 *   3. Inline function-type annotation (`() => IFoo`) → FactorySlot (PRD §7).
 *   4. Inline union type annotation (`A | B`) → UnionSlot (`| undefined` becomes
 *      the optional fallback below; `| null` survives as a real member).
 *   5a. Singular literal (`"dev"` / `42` / `true` / `1n`) → LiteralSlot (Rule 2).
 *   5b. Normal type → string token via `tokenForType`.
 *   6. Anonymous structure + no brand → hard diagnostic (UnderivableToken).
 *
 * OPTIONALITY (unified on union): a param that is optional in ANY form — `x?: X`,
 * `x: X = default`, `x: X | undefined`, `x: X | void` — at ANY position lowers to
 * `union(<non-nullish slots>, { value: undefined })` with the LiteralRef fallback
 * LAST. Union is first-resolvable-wins in declaration order, so `X` still wins
 * when registered; otherwise `undefined` is supplied (a LiteralRef is always
 * satisfiable). `x: X | null` likewise yields `union(X, { value: null })` (the
 * null member is a real union member, not the optionality marker). There is no
 * overload expansion — auto-extraction emits exactly one signature.
 *
 * Detection is purely syntactic (the annotation node shape), never on the
 * resolved type — the resolved `ts.Type` of an inline arrow and of a named
 * callable interface are structurally identical, so only the syntax tells them
 * apart.
 *
 * INSTANTIATED-TYPE OVERRIDE: for a generic impl registered via an
 * instantiation expression (`add<IRepo<$<1>>>(SqlRepo<$<1>>)`), the param's
 * declaration node carries the UNSUBSTITUTED type (`T`, `IRepo<T>`), while the
 * checker's instantiated construct signature carries the substituted one
 * (`Hole<1>`, `IRepo<Hole<1>>`). `typeOverride` supplies the substituted type;
 * the declaration node keeps driving the SYNTACTIC classification (optional /
 * FunctionTypeNode / UnionTypeNode).
 */
function extractParamSlot(
  param: ts.ParameterDeclaration,
  ctx: DepContext,
  typeOverride?: ts.Type,
): Slot {
  const rawType = typeOverride ?? ctx.checker.getTypeAtLocation(param);

  // 1. A `ResolveScope`-typed parameter is the live scope, not a token.
  if (isResolveScopeType(rawType)) {return { scope: true };}

  // 1.5. A `Typeof<T>`-typed parameter receives the token STRING of a
  //      registration type argument: a Hole binding stays an open
  //      `{ typeArg: N }` slot; a concrete binding closes to its derived token
  //      as a literal value slot.
  const typeArgSlot = typeArgSlotFor(rawType, param, ctx);
  if (typeArgSlot !== undefined) {return typeArgSlot;}

  // 2. Check for the Inject<T, "tok"> brand. A brand on the WHOLE (single,
  //    non-nullish, non-union) param type wins unconditionally and short-circuits
  //    here. A brand on a MEMBER of an optional / explicit union (`x?:
  //    Inject<T,K>`, `Inject<T,K> | IBar`) must NOT collapse the whole param to one
  //    token — it would drop the `undefined` fallback or the other members — so it
  //    is handled per-member in the union/optional paths below (via
  //    `extractParamSlotFromTypeNode` / `nonNullishMemberSlots`, which check the
  //    brand on each member first).
  if (!isOptionalParam(param, ctx, typeOverride) && !isMultiMemberUnion(rawType)) {
    const brandedToken = injectTokenFor(rawType, ctx.checker);
    if (brandedToken !== undefined) {return brandedToken;}
  }

  // Optional in any form (`x?`, `= default`, `x: X | undefined`/`| void`): the
  // non-nullish slot(s) come first, with a `{ value: undefined }` LiteralRef
  // fallback appended LAST. The fallback is always satisfiable, so the param can
  // never make a signature unresolvable; the real dep still wins when registered.
  // A branded non-nullish member keeps its brand (see `nonNullishMemberSlots`).
  if (isOptionalParam(param, ctx, typeOverride)) {
    const members = nonNullishMemberSlots(param, ctx, typeOverride);
    // A whole-type `undefined` / `void` param has no non-nullish core — it IS the
    // undefined value, so emit the bare LiteralRef (the union would be redundant).
    if (!members.length) {return { value: undefined };}
    return { union: [...members, { value: undefined }] };
  }

  // 3. Inline factory (syntactic: annotation is a FunctionTypeNode).
  const factory = factorySlotFor(param, ctx, typeOverride);
  if (factory) {return factory;}

  // 4. Inline union (syntactic: annotation is a UnionTypeNode). A `| null` member
  //    survives (lowered to `{ value: null }` by extractParamSlotFromTypeNode);
  //    `| undefined` was already consumed by the optional branch above. Named type
  //    aliases that expand to a union are TypeReferenceNodes — they fall to step 5.
  //    A PURE-LITERAL union (`"a" | "b"`) is NOT lowered to a union slot — it is a
  //    discriminated choice that `literalToken` mints one sorted token for, so it
  //    falls through to step 5 (tokenForType).
  const typeNode = param.type;
  if (
    typeNode &&
    ts.isUnionTypeNode(typeNode) &&
    typeNode.types.length >= 2 &&
    !isPureLiteralUnion(rawType) &&
    // `true | false` is syntactically a union but resolves to the wide `boolean`
    // type — let step 5 tokenize it as `"boolean"` rather than a LiteralRef union.
    !(rawType.flags & ts.TypeFlags.Boolean) &&
    // Under an instantiation-expression override, the SUBSTITUTED type may no
    // longer be a union that pairs member-for-member with the syntactic node —
    // `T | Bar` with `T = Bar` collapses to the bare `Bar`. Descending into the
    // per-member loop would then derive the UNSUBSTITUTED declaration nodes (the
    // bare type parameter `T`) and hard-error; fall through to whole-type
    // derivation (step 5, which uses the substituted `rawType`) instead.
    overrideMatchesSyntacticUnion(typeOverride, typeNode.types.length)
  ) {
    const overrides = unionMemberOverrides(
      typeOverride,
      typeNode.types.length,
      false,
    );
    const memberSlots = typeNode.types.map((memberTypeNode, i) =>
      extractParamSlotFromTypeNode(memberTypeNode, param, ctx, overrides[i]),
    );
    return { union: memberSlots };
  }

  // 5. Normal derivation.
  const type = rawType;

  // Rule 2: a SINGULAR type supplies its value directly — emit a LiteralRef slot,
  // no container lookup. Covers literals (`"dev"`, `42`, `true`, `1n`) and the
  // whole-type singletons `null` (→ null). `void` / `undefined` as a whole type
  // are optional (handled above). A UNION returns undefined here.
  const singleton = singletonValue(type);
  if (singleton) {return { value: singleton.value };}

  const failure: DeriveFailure = {};
  const result = tokenForType(type, ctx, failure);
  if (result !== undefined) {return result.token;}

  // 6. Hard error: no derivable token and no Inject brand. An unbound type
  //    parameter gets the sharper diagnostic — the fix is an instantiation
  //    expression, not a name.
  ctx.sink.addDiagnostic(
    failure.unboundTypeParameter
      ? error(
          ctx.sourceFile,
          param.type ?? param,
          DiagnosticCode.UnboundTypeParameter,
          "this parameter references an unbound type parameter — register the class " +
            "via an instantiation expression that binds it (`add<IFoo<$<1>>>(Foo<$<1>>)` " +
            "for an open template, or `Foo<Concrete>` for a closed one)",
        )
      : error(
          ctx.sourceFile,
          param.type ?? param,
          DiagnosticCode.UnderivableToken,
          "cannot derive a token for this type — name the type or brand the parameter with `Inject<T, 'my:token'>`",
        ),
  );
  // Return a sentinel string so the signature array is still well-shaped for
  // downstream processing; the hard error will stop compilation.
  return "??unresolvable??";
}

/**
 * The `Typeof<T>` slot for a parameter type, or `undefined` when the type
 * is not a `Typeof` reference. A Hole binding yields the open
 * `{ typeArg: N }` slot; a concrete binding yields the derived token as a
 * `{ value: "<token>" }` literal slot (the closed form needs no substitution).
 * A binding with no derivable token is the same hard error as any other
 * underivable parameter.
 */
function typeArgSlotFor(
  type: ts.Type,
  param: ts.ParameterDeclaration,
  ctx: DepContext,
): Slot | undefined {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (symbol?.getName() !== TYPE_ARG_TOKEN_NAME) {return undefined;}
  const binding = type.aliasTypeArguments?.[0];
  if (!binding) {return undefined;}

  const hole = holeNumberFor(binding, ctx.checker);
  if (hole !== undefined) {return { typeArg: hole };}

  const failure: DeriveFailure = {};
  const token = deriveToken(binding, ctx, failure);
  if (token !== undefined) {return { value: token };}

  ctx.sink.addDiagnostic(
    failure.unboundTypeParameter
      ? error(
          ctx.sourceFile,
          param.type ?? param,
          DiagnosticCode.UnboundTypeParameter,
          "the Typeof binding references an unbound type parameter — register " +
            "the class via an instantiation expression that binds it (`Foo<$<1>>` or " +
            "`Foo<Concrete>`)",
        )
      : error(
          ctx.sourceFile,
          param.type ?? param,
          DiagnosticCode.UnderivableToken,
          "cannot derive a token for this Typeof binding — name the type",
        ),
  );
  return "??unresolvable??";
}

/**
 * True when the per-member union pairing is safe: there is NO instantiation
 * override (the ordinary syntactic-union path applies), or the substituted
 * override is itself a union whose constituent count matches the syntactic
 * member count. When an override is present but collapsed (`T | Bar` → `Bar`)
 * or otherwise mismatched, member-for-member pairing would fall back to the
 * unsubstituted declaration nodes and hard-error on the bare type parameter —
 * the caller must derive the whole substituted type as one slot instead.
 */
function overrideMatchesSyntacticUnion(
  override: ts.Type | undefined,
  memberCount: number,
): boolean {
  if (override === undefined) {return true;}
  return override.isUnion() && override.types.length === memberCount;
}

/**
 * Positionally pair an instantiated UNION override with a syntactic union
 * node's members. Returns one override (or `undefined`) per member. Pairing is
 * best-effort: when the override is not a union, or the constituent count
 * (after optionally stripping the `undefined`/`void` the optional path
 * consumed) differs from the syntactic member count — union normalization can
 * reorder or collapse members — every member falls back to its own node type.
 */
function unionMemberOverrides(
  override: ts.Type | undefined,
  memberCount: number,
  stripUndefinedAndVoid: boolean,
): readonly (ts.Type | undefined)[] {
  const none: (ts.Type | undefined)[] = Array.from(
    { length: memberCount },
    () => undefined,
  );
  if (!override || !override.isUnion()) {return none;}
  const members = stripUndefinedAndVoid
    ? override.types.filter(
        (t) => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)),
      )
    : override.types;
  return members.length === memberCount ? members : none;
}

/**
 * The slot(s) for the NON-undefined/void part of an optional param — the members
 * that precede the `{ value: undefined }` fallback in the optional union.
 *
 *   - inline union node (`X | Y | undefined`) → one slot per non-`undefined`/
 *     non-`void` member, in declaration order (a `| null` member survives and
 *     lowers to `{ value: null }`);
 *   - any other annotation (`x?: X`, `x: X = d`) → the single slot for `X`
 *     (the param's resolved type with `| undefined` already stripped by the
 *     checker for a `?`/defaulted param; an explicit `X | void` whole type is
 *     not a union node, so its non-void core is derived from the resolved type).
 *
 * Returns at least one slot; the caller appends the `undefined` fallback.
 */
function nonNullishMemberSlots(
  param: ts.ParameterDeclaration,
  ctx: DepContext,
  typeOverride?: ts.Type,
): Slot[] {
  const rawType = typeOverride ?? ctx.checker.getTypeAtLocation(param);

  // A pure-literal non-nullish core (`"a" | "b" | undefined`) stays ONE sorted
  // literal-union token, not per-member LiteralRefs — same as a non-optional
  // pure-literal union (step 4). Render it from just the non-nullish members
  // (`nonNullish` keeps `| undefined` in place when >1 member survives, and
  // `literalToken` rejects the union outright once a nullish member is present).
  // Wide `boolean | undefined` is explicitly excluded by `literalUnionTokenForOptional`
  // and falls through here so the annotation-based path below yields `"boolean"`.
  const literalUnion = literalUnionTokenForOptional(rawType);
  if (literalUnion !== undefined) {return [literalUnion];}

  const core = nonNullish(rawType);
  const typeNode = param.type;
  if (typeNode && ts.isUnionTypeNode(typeNode)) {
    const kept = typeNode.types.filter(
      (t) =>
        t.kind !== ts.SyntaxKind.UndefinedKeyword &&
        t.kind !== ts.SyntaxKind.VoidKeyword,
    );
    if (kept.length) {
      // When every surviving member resolves to a BooleanLiteral, the pair
      // `true | false` is the wide boolean — collapse to the scalar `"boolean"`
      // token rather than two separate LiteralRef slots.
      if (
        kept.every(
          (t) =>
            !!(ctx.checker.getTypeFromTypeNode(t).flags &
              ts.TypeFlags.BooleanLiteral),
        )
      ) {
        return ["boolean"];
      }
      const overrides = unionMemberOverrides(typeOverride, kept.length, true);
      return kept.map((t, i) =>
        extractParamSlotFromTypeNode(t, param, ctx, overrides[i]),
      );
    }
  }
  // No inline union: derive the single non-nullish slot from the resolved type.
  // A whole-type `undefined` / `void` has no non-nullish core at all.
  if (core.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) {return [];}
  // The Inject brand on the (nullish-stripped) core survives — `x?:
  // Inject<T,K>` must keep its branded token, not derive structurally.
  const brandedCore = injectTokenFor(core, ctx.checker);
  if (brandedCore !== undefined) {return [brandedCore];}
  // Likewise a `tok?: Typeof<T>` keeps its type-arg slot.
  const typeArgSlot = typeArgSlotFor(core, param, ctx);
  if (typeArgSlot !== undefined) {return [typeArgSlot];}
  const singleton = singletonValue(core);
  if (singleton) {return [{ value: singleton.value }];}
  // `nonNullish` can only collapse a union when a SINGLE non-nullish member
  // survives. When two non-nullish members survive (e.g. `false | true` from
  // `boolean | undefined`), `core` is still the original union, and
  // `tokenForType(core)` would fail because the outer union has no intrinsic
  // name. Derive from the type annotation node instead when available — the node
  // carries the *unannotated* type (e.g. the `boolean` keyword) without the
  // synthesised `| undefined` that the checker appends for `?` params.
  if (core === rawType && typeNode && !ts.isUnionTypeNode(typeNode)) {
    const nodeType = ctx.checker.getTypeFromTypeNode(typeNode);
    const nodeResult = tokenForType(nodeType, ctx);
    if (nodeResult !== undefined) {return [nodeResult.token];}
  }
  const result = tokenForType(core, ctx);
  return result !== undefined ? [result.token] : [];
}

/**
 * Lower a single type node from an inline union into a Slot, reusing the
 * parent parameter's context. The type node is a union constituent — we
 * synthesise a temporary ParameterDeclaration-like context for recursive calls.
 */
function extractParamSlotFromTypeNode(
  typeNode: ts.TypeNode,
  parentParam: ts.ParameterDeclaration,
  ctx: DepContext,
  memberOverride?: ts.Type,
): Slot {
  // Check for Inject brand on the resolved type of this member.
  const memberType = memberOverride ?? ctx.checker.getTypeFromTypeNode(typeNode);
  const brandedToken = injectTokenFor(memberType, ctx.checker);
  if (brandedToken !== undefined) {return brandedToken;}

  // A `Typeof<T>` union member keeps its type-arg slot.
  const typeArgSlot = typeArgSlotFor(memberType, parentParam, ctx);
  if (typeArgSlot !== undefined) {return typeArgSlot;}

  // Nested factory: an inline function type node within a union member.
  if (ts.isFunctionTypeNode(typeNode)) {
    const signature = ctx.checker.getSignatureFromDeclaration(typeNode);
    if (signature) {
      const token = tokenForReturnType(signature, ctx);
      if (token !== undefined) {return { type: token };}
    }
  }

  // Nested union (uncommon but allowed by DepSlot).
  if (ts.isUnionTypeNode(typeNode)) {
    const nonUndefinedMembers = typeNode.types.filter(
      (t) => t.kind !== ts.SyntaxKind.UndefinedKeyword,
    );
    if (nonUndefinedMembers.length >= 2) {
      const memberSlots = nonUndefinedMembers.map((m) =>
        extractParamSlotFromTypeNode(m, parentParam, ctx),
      );
      return { union: memberSlots };
    }
    if (nonUndefinedMembers.length === 1) {
      return extractParamSlotFromTypeNode(nonUndefinedMembers[0]!, parentParam, ctx);
    }
  }

  // Rule 2: a SINGULAR member supplies its value directly (LiteralRef).
  const singleton = singletonValue(memberType);
  if (singleton) {return { value: singleton.value };}

  // Normal derivation (from the resolved member type — the instantiated
  // override when present, the node's own type otherwise).
  const token = tokenForType(memberType, ctx)?.token;
  if (token !== undefined) {return token;}

  // Hard error for this union member.
  ctx.sink.addDiagnostic(
    error(
      ctx.sourceFile,
      typeNode,
      DiagnosticCode.UnderivableToken,
      "cannot derive a token for this type — name the type or brand the parameter with `Inject<T, 'my:token'>`",
    ),
  );
  return "??unresolvable??";
}

/** True when a param's resolved type is the `ResolveScope` contract interface. */
function isResolveScopeType(type: ts.Type): boolean {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  return symbol?.getName() === RESOLVE_SCOPE_NAME;
}

/**
 * Extract the parameter signature of a registration-level FACTORY function (an
 * arrow or function expression). Mirrors `extractSignatureFromClass` but over a
 * function literal's parameters — each becomes a token / factory ref /
 * scope ref / union slot via the same per-parameter classifier.
 */
export function extractSignatureFromFunction(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  ctx: DepContext,
): Signature[] {
  return paramsToSignatures(fn.parameters, ctx);
}

/**
 * Map a resolved call/construct `ts.Signature`'s parameters to slots, reusing
 * the same per-parameter classifier as a class ctor. Returns `undefined` when a
 * parameter cannot be read positionally — no declaration, or a rest parameter
 * (`...args: [A, B]`) whose tuple cannot be cleanly expanded per-slot — so the
 * caller falls back to a dynamic (no-dep-array) registration rather than emit a
 * misleading signature.
 */
function signatureToSlots(
  signature: ts.Signature,
  ctx: DepContext,
): Signature[] | undefined {
  const params: ts.ParameterDeclaration[] = [];
  for (const paramSymbol of signature.parameters) {
    const decl = paramSymbol.valueDeclaration;
    if (!decl || !ts.isParameter(decl) || decl.dotDotDotToken) {return undefined;}
    params.push(decl);
  }
  return paramsToSignatures(params, ctx);
}

/**
 * Extract the parameter signature of a registration arg that is a FACTORY VALUE
 * — anything whose type is callable but not constructable: a named function
 * reference (`add<I>(myFactory)`), a const-bound arrow, an imported function, a
 * `.bind(…)` result, or a call returning a function (`add<I>(getFactory())`).
 * Returns `undefined` when the arg is NOT callable-only (a class — which has
 * construct signatures — or a non-callable value), so the caller routes it down
 * the class / dynamic path. Hoisting (for non-stable args) is the caller's call.
 */
export function extractFactoryReferenceSignature(
  expr: ts.Expression,
  ctx: DepContext,
): Signature[] | undefined {
  const type = ctx.checker.getTypeAtLocation(expr);
  // A class/constructable resolves down the class path, never here.
  if (type.getConstructSignatures().length) {return undefined;}
  const callSignatures = type.getCallSignatures();
  if (!callSignatures.length) {return undefined;}
  // Map ALL call signatures (declared overloads), not just the first one.
  // The static class-declaration path (`extractSignatureFromClass`) emits one
  // signature per declared overload; this path must match that behaviour.
  const results: Signature[] = [];
  for (const sig of callSignatures) {
    const slots = signatureToSlots(sig, ctx);
    if (slots === undefined) {return undefined;}
    results.push(...slots);
  }
  return results.length ? results : undefined;
}

/**
 * Extract the constructor signature of a registration arg that is a
 * CONSTRUCTABLE VALUE with no static class declaration — a `getCtor()` result, a
 * const-bound class expression, etc. (a plain `add<I>(SqlUserRepo)` reference is
 * handled by `extractFromExpression` with its full set of checks). Returns
 * `undefined` when the arg is not constructable, so the caller treats it as
 * dynamic.
 */
export function extractCtorReferenceSignature(
  expr: ts.Expression,
  ctx: DepContext,
): Signature[] | undefined {
  const constructSignatures = ctx.checker
    .getTypeAtLocation(expr)
    .getConstructSignatures();
  if (!constructSignatures.length) {return undefined;}
  // Map ALL construct signatures (declared overloads), not just the first one.
  // The static class-declaration path (`extractSignatureFromClass`) emits one
  // signature per declared overload; this path must match that behaviour.
  const results: Signature[] = [];
  for (const sig of constructSignatures) {
    const slots = signatureToSlots(sig, ctx);
    if (slots === undefined) {return undefined;}
    results.push(...slots);
  }
  return results.length ? results : undefined;
}

/**
 * Extract the constructor signature(s) of an INSTANTIATION EXPRESSION
 * registration arg (`add<IRepo<$<1>>>(SqlRepository<$<1>>)` — an
 * `ExpressionWithTypeArguments` in value position). The checker's construct
 * signatures on the EWTA's type are already INSTANTIATED (holes and concrete
 * args substituted for the class's type parameters), so the "inverted mapping"
 * (`Foo<$<2>,$<1>>`) falls out for free. Each param pairs its DECLARATION node
 * (syntactic classification: optional / FunctionTypeNode / UnionTypeNode) with
 * the instantiated type from `checker.getTypeOfSymbol` — the declaration node
 * alone would yield the unsubstituted type parameters.
 *
 * Returns `undefined` when the expression is not constructable or a parameter
 * cannot be read positionally (no declaration / rest param), so the caller
 * falls back to its non-EWTA handling.
 */
export function extractInstantiatedSignature(
  ewta: ts.ExpressionWithTypeArguments,
  ctx: DepContext,
): Signature[] | undefined {
  const constructSignatures = ctx.checker
    .getTypeAtLocation(ewta)
    .getConstructSignatures();
  if (!constructSignatures.length) {return undefined;}

  const results: Signature[] = [];
  for (const sig of constructSignatures) {
    const slots: Slot[] = [];
    for (const paramSymbol of sig.parameters) {
      const decl = paramSymbol.valueDeclaration;
      if (!decl || !ts.isParameter(decl) || decl.dotDotDotToken) {
        return undefined;
      }
      slots.push(
        extractParamSlot(decl, ctx, ctx.checker.getTypeOfSymbol(paramSymbol)),
      );
    }
    results.push(slots);
  }
  return results;
}

/**
 * If `param`'s type annotation is an inline function-type literal, return its
 * factory slot (keyed on the return type's token). Returns `undefined` when the
 * annotation is anything else — including a named function-interface reference
 * (the opt-out) — or when the return type yields no derivable token.
 *
 * When the inline function type declares parameters, each declared param's type
 * is resolved to a token (same derivation rules as ctor params via `slotForParam`
 * / `tokenForType`). Those tokens are emitted as `params` in the returned slot so
 * the runtime partitioner can route caller-supplied args into the right ctor slots
 * (caller wins over registration). Zero declared params → bare `{ type: token }`
 * (strict zero-arg mode, unchanged). A declared param whose type yields no
 * derivable token (anonymous structure) raises an `UnderivableToken` hard
 * diagnostic — a caller-supplied param with no matchable token is unusable.
 *
 * The `.type` field replaces the former `.factory` field (T0 rename).
 */
function factorySlotFor(
  param: ts.ParameterDeclaration,
  ctx: DepContext,
  typeOverride?: ts.Type,
): FactorySlot | undefined {
  const typeNode = param.type;
  if (!typeNode || !ts.isFunctionTypeNode(typeNode)) {return undefined;}

  // The INSTANTIATED call signature when an override is present (a generic
  // impl registered via an instantiation expression — the declaration's own
  // signature would carry unsubstituted type parameters), the declaration's
  // otherwise.
  const signature = typeOverride
    ? typeOverride.getCallSignatures()[0]
    : ctx.checker.getSignatureFromDeclaration(typeNode);
  if (!signature) {return undefined;}

  const token = tokenForReturnType(signature, ctx);
  if (token === undefined) {return undefined;}

  // Zero declared params → strict zero-arg mode; no params field.
  if (!typeNode.parameters.length) {return { type: token };}

  // One or more declared params → derive a token for each. A declared param
  // whose type yields no token (anonymous structure) is a hard error: the runtime
  // cannot match a caller arg with no token to route it to the right ctor slot.
  // Under an override, each param's token derives from the instantiated
  // signature's param symbol (positionally paired with the declaration node).
  const params: string[] = [];
  for (let i = 0; i < typeNode.parameters.length; i++) {
    const p = typeNode.parameters[i]!;
    const overrideSymbol = typeOverride ? signature.parameters[i] : undefined;
    const t = overrideSymbol
      ? tokenForSymbolType(overrideSymbol, ctx)
      : slotForParam(p, ctx);
    if (t === null) {
      ctx.sink.addDiagnostic(
        error(
          ctx.sourceFile,
          p.type ?? p,
          DiagnosticCode.UnderivableToken,
          "cannot derive a token for this factory parameter type — name the type so the runtime can route the caller-supplied argument",
        ),
      );
      // Keep a sentinel so the slot is still well-shaped for downstream processing.
      params.push("??unresolvable??");
    } else {
      params.push(t);
    }
  }
  return { type: token, params };
}

/**
 * The implementation constructor (the declaration WITH a body) — the real
 * construction shape. Used by the §4.5 produced-ctor analysis, which needs the
 * actual parameter list, not the caller-visible overloads. Signature extraction
 * (`extractSignatureFromClass`) selects ctors itself: declared overloads when
 * present, the implementation otherwise.
 */
export function findConstructor(
  classDecl: ts.ClassDeclaration,
): ts.ConstructorDeclaration | undefined {
  const ctors = classDecl.members.filter(ts.isConstructorDeclaration);
  return ctors.find((c) => c.body !== undefined) ?? ctors[0];
}

/** The class declaration backing a `ts.Type`, if its symbol declares one. */
export function classDeclarationOfType(
  type: ts.Type,
): ts.ClassDeclaration | undefined {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  return symbol?.getDeclarations()?.find(ts.isClassDeclaration);
}

/**
 * The token (or `null` for an unresolvable/hole type) for a single parameter —
 * used by the §4.5 diagnostic to compare a factory's declared call signature
 * against the produced ctor's unregistered params. Returns `null` when the type
 * yields no derivable token (replaces the former `hole`-based check). The
 * diagnostic still works: `null` slots are "holes" from the diagnostic's perspective.
 */
export function slotForParam(
  param: ts.ParameterDeclaration,
  ctx: TokenContext,
): string | null {
  const type = nonNullish(ctx.checker.getTypeAtLocation(param));
  const result = tokenForType(type, ctx);
  return result === undefined ? null : result.token;
}

/**
 * `slotForParam` over a resolved SYMBOL — used when the type must come from an
 * instantiated signature's param symbol (`checker.getTypeOfSymbol`) rather than
 * the declaration node, which would carry unsubstituted type parameters.
 */
function tokenForSymbolType(
  symbol: ts.Symbol,
  ctx: TokenContext,
): string | null {
  const type = nonNullish(ctx.checker.getTypeOfSymbol(symbol));
  const result = tokenForType(type, ctx);
  return result === undefined ? null : result.token;
}

// ── optionality (unified on union — no overload expansion) ───────────────────

/**
 * True when a parameter is optional — a `?` token, a default initializer, or a
 * type that admits `undefined` / `void` (`dep: IFoo | undefined`, `x: T | void`).
 * An optional param lowers to a `union(<non-nullish>, { value: undefined })`
 * fallback (see `extractParamSlot`); there is no overload expansion.
 */
function isOptionalParam(
  param: ts.ParameterDeclaration,
  ctx: TokenContext,
  typeOverride?: ts.Type,
): boolean {
  if (param.questionToken !== undefined || param.initializer !== undefined) {
    return true;
  }
  return typeIncludesUndefinedOrVoid(
    typeOverride ?? ctx.checker.getTypeAtLocation(param),
  );
}

/** True when a type is `undefined`/`void`, or a union with such a member. */
function typeIncludesUndefinedOrVoid(type: ts.Type): boolean {
  const nullish = ts.TypeFlags.Undefined | ts.TypeFlags.Void;
  if (type.flags & nullish) {return true;}
  return type.isUnion() && type.types.some((t) => t.flags & nullish);
}

/**
 * True when a type is a union with two or more NON-nullish members (a real
 * union of alternatives, `IFoo | IBar`), as opposed to a single type or a
 * one-member-plus-`undefined` optional. A whole-type Inject-brand short-circuit
 * must NOT fire for such a union — its brand belongs to one member, and
 * collapsing the union to that token would silently drop the other members.
 */
function isMultiMemberUnion(type: ts.Type): boolean {
  if (!type.isUnion()) {return false;}
  const nullish =
    ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void;
  return type.types.filter((t) => !(t.flags & nullish)).length >= 2;
}

/**
 * Strip `undefined` / `null` / `void` from a union, returning the sole surviving
 * member when exactly one remains (`IFoo | undefined` → `IFoo`). A union with
 * multiple non-nullish members is returned unchanged — `deriveToken` handles it
 * (a literal union renders its token; a typed union resolves by alias or holes).
 */
function nonNullish(type: ts.Type): ts.Type {
  if (!type.isUnion()) {return type;}
  const kept = type.types.filter(
    (t) =>
      !(t.flags &
        (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)),
  );
  return kept.length === 1 ? kept[0]! : type;
}
