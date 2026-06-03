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
  isPureLiteralUnion,
  literalUnionTokenForOptional,
  singletonValue,
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
 * `{ type: "<token>", params: [...] }` when params are present) in the
 * `defineDeps(...)` signature array.
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
 * `{ union: [slotA, slotB, ...] }` in the `defineDeps(...)` signature array.
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
 * `defineDeps(...)` signature array. A literal/nullish UNION (`"a" | "b"`,
 * `Foo | undefined`) is NOT a literal slot. `value` may itself be `undefined`,
 * so the slot is identified by the PRESENCE of the `value` key.
 */
export interface LiteralSlot {
  readonly value: LiteralValue;
}

/**
 * One positional slot: a token string, a factory ref, a scope ref, a union of
 * alternatives, or a literal value. There is no `null` / hole sentinel — an
 * unresolvable (anonymous-structure) type causes a hard compile error
 * (`UnderivableToken`).
 */
export type Slot = string | FactorySlot | ScopeSlot | UnionSlot | LiteralSlot;

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
 * Structural equality for slots. Two slots are equal when:
 *   - both are the same string token
 *   - both are factory refs with the same type and params
 *   - both are scope refs
 *   - both are union slots with element-wise equal members (recursive)
 *   - both are literal slots with strictly-equal values
 */
export function slotsEqual(a: Slot, b: Slot): boolean {
  if (a === b) {return true;}
  if (typeof a === "string" || typeof b === "string") {return false;}
  if (isScopeSlot(a) && isScopeSlot(b)) {return true;}
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
 * still fires. The multi-signature `Token[][]` ABI is retained for MANUAL
 * `@signature` / `forCtor` overloads.
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
 */
function extractParamSlot(
  param: ts.ParameterDeclaration,
  ctx: DepContext,
): Slot {
  // 1. A `ResolveScope`-typed parameter is the live scope, not a token.
  if (isResolveScopeParam(param, ctx)) {return { scope: true };}

  // 2. Check for the Inject<T, "tok"> brand. A brand on the WHOLE (single,
  //    non-nullish, non-union) param type wins unconditionally and short-circuits
  //    here. A brand on a MEMBER of an optional / explicit union (`x?:
  //    Inject<T,K>`, `Inject<T,K> | IBar`) must NOT collapse the whole param to one
  //    token — it would drop the `undefined` fallback or the other members — so it
  //    is handled per-member in the union/optional paths below (via
  //    `extractParamSlotFromTypeNode` / `nonNullishMemberSlots`, which check the
  //    brand on each member first).
  const rawType = ctx.checker.getTypeAtLocation(param);
  if (!isOptionalParam(param, ctx) && !isMultiMemberUnion(rawType)) {
    const brandedToken = injectTokenFor(rawType, ctx.checker);
    if (brandedToken !== undefined) {return brandedToken;}
  }

  // Optional in any form (`x?`, `= default`, `x: X | undefined`/`| void`): the
  // non-nullish slot(s) come first, with a `{ value: undefined }` LiteralRef
  // fallback appended LAST. The fallback is always satisfiable, so the param can
  // never make a signature unresolvable; the real dep still wins when registered.
  // A branded non-nullish member keeps its brand (see `nonNullishMemberSlots`).
  if (isOptionalParam(param, ctx)) {
    const members = nonNullishMemberSlots(param, ctx);
    // A whole-type `undefined` / `void` param has no non-nullish core — it IS the
    // undefined value, so emit the bare LiteralRef (the union would be redundant).
    if (!members.length) {return { value: undefined };}
    return { union: [...members, { value: undefined }] };
  }

  // 3. Inline factory (syntactic: annotation is a FunctionTypeNode).
  const factory = factorySlotFor(param, ctx);
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
    !(rawType.flags & ts.TypeFlags.Boolean)
  ) {
    const memberSlots = typeNode.types.map((memberTypeNode) =>
      extractParamSlotFromTypeNode(memberTypeNode, param, ctx),
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

  const result = tokenForType(type, ctx);
  if (result !== undefined) {return result.token;}

  // 6. Hard error: no derivable token and no Inject brand.
  ctx.sink.addDiagnostic(
    error(
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
): Slot[] {
  const rawType = ctx.checker.getTypeAtLocation(param);

  // A pure-literal non-nullish core (`"a" | "b" | undefined`) stays ONE sorted
  // literal-union token, not per-member LiteralRefs — same as a non-optional
  // pure-literal union (step 4). Render it from just the non-nullish members
  // (`nonNullish` keeps `| undefined` in place when >1 member survives, and
  // `literalToken` rejects the union outright once a nullish member is present).
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
      return kept.map((t) => extractParamSlotFromTypeNode(t, param, ctx));
    }
  }
  // No inline union: derive the single non-nullish slot from the resolved type.
  // A whole-type `undefined` / `void` has no non-nullish core at all.
  if (core.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) {return [];}
  // The Inject brand on the (nullish-stripped) core survives — `x?:
  // Inject<T,K>` must keep its branded token, not derive structurally.
  const brandedCore = injectTokenFor(core, ctx.checker);
  if (brandedCore !== undefined) {return [brandedCore];}
  const singleton = singletonValue(core);
  if (singleton) {return [{ value: singleton.value }];}
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
): Slot {
  // Check for Inject brand on the resolved type of this member.
  const memberType = ctx.checker.getTypeFromTypeNode(typeNode);
  const brandedToken = injectTokenFor(memberType, ctx.checker);
  if (brandedToken !== undefined) {return brandedToken;}

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

  // Normal derivation.
  const token = deriveTokenForTypeNode(typeNode, ctx);
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

/** Derive a token for a type node (used in union-member extraction). */
function deriveTokenForTypeNode(
  typeNode: ts.TypeNode,
  ctx: DepContext,
): string | undefined {
  const type = ctx.checker.getTypeFromTypeNode(typeNode);
  const result = tokenForType(type, ctx);
  return result?.token;
}

/** True when `param`'s type resolves to the `ResolveScope` contract interface. */
function isResolveScopeParam(
  param: ts.ParameterDeclaration,
  ctx: TokenContext,
): boolean {
  const type = ctx.checker.getTypeAtLocation(param);
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
  return signatureToSlots(callSignatures[0]!, ctx);
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
  return signatureToSlots(constructSignatures[0]!, ctx);
}

/**
 * If `param`'s type annotation is an inline function-type literal, return its
 * factory slot (keyed on the return type's token). Returns `undefined` when the
 * annotation is anything else — including a named function-interface reference
 * (the opt-out) — or when the return type yields no derivable token.
 *
 * The `.type` field replaces the former `.factory` field (T0 rename).
 */
function factorySlotFor(
  param: ts.ParameterDeclaration,
  ctx: TokenContext,
): FactorySlot | undefined {
  const typeNode = param.type;
  if (!typeNode || !ts.isFunctionTypeNode(typeNode)) {return undefined;}

  const signature = ctx.checker.getSignatureFromDeclaration(typeNode);
  if (!signature) {return undefined;}

  const token = tokenForReturnType(signature, ctx);
  if (token === undefined) {return undefined;}
  return { type: token };
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
): boolean {
  if (param.questionToken !== undefined || param.initializer !== undefined) {
    return true;
  }
  return typeIncludesUndefinedOrVoid(ctx.checker.getTypeAtLocation(param));
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

/** True when the class carries a `@signature` decorator (manual annotation). */
export function hasSignatureDecorator(classDecl: ts.ClassDeclaration): boolean {
  const decorators = ts.getDecorators(classDecl);
  if (!decorators) {return false;}
  return decorators.some((d) => decoratorName(d) === "signature");
}

function decoratorName(decorator: ts.Decorator): string | undefined {
  const expr = decorator.expression;
  if (ts.isCallExpression(expr)) {
    const callee = expr.expression;
    if (ts.isIdentifier(callee)) {return callee.text;}
    if (ts.isPropertyAccessExpression(callee)) {return callee.name.text;}
  }
  if (ts.isIdentifier(expr)) {return expr.text;}
  if (ts.isPropertyAccessExpression(expr)) {return expr.name.text;}
  return undefined;
}
