// Constructor dependency extraction (PRD §8 "Dep extraction"; §7 factories).
//
// Given a concrete class's constructor, read each parameter's type via the
// TypeChecker and compute one slot per parameter:
//   - Inject<T, "tok"> branded param       →  the branded token string
//   - `Promise<X>`                          →  the token for `X`
//   - an inline function type `() => IFoo` →  a factory ref { type: token-of-IFoo }
//   - an inline union `A | B`              →  a UnionSlot { union: [slotA, slotB] }
//   - everything else                      →  a string token
//   - unresolvable type with no brand      →  hard diagnostic (UnderivableToken)
// The result is ONE signature (a positional array), matching the single
// canonical ctor the transformer sees statically.

import ts from "typescript";
import {
  tokenForType,
  tokenForReturnType,
  injectTokenFor,
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
 * One positional slot: a token string, a factory ref, a scope ref, or a union of
 * alternatives. There is no `null` / hole sentinel — an unresolvable type causes
 * a hard compile error (`UnderivableToken`).
 */
export type Slot = string | FactorySlot | ScopeSlot | UnionSlot;

/** One emitted signature: positional slots (token / hole / factory / scope). */
export type Signature = ReadonlyArray<Slot>;

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
 * Structural equality for slots. Two slots are equal when:
 *   - both are the same string token
 *   - both are factory refs with the same type and params
 *   - both are scope refs
 *   - both are union slots with element-wise equal members (recursive)
 */
export function slotsEqual(a: Slot, b: Slot): boolean {
  if (a === b) return true;
  if (typeof a === "string" || typeof b === "string") return false;
  if (isScopeSlot(a) && isScopeSlot(b)) return true;
  if (isFactorySlot(a) && isFactorySlot(b)) {
    if (a.type !== b.type) return false;
    const ap = a.params ?? [];
    const bp = b.params ?? [];
    if (ap.length !== bp.length) return false;
    return ap.every((p, i) => p === bp[i]);
  }
  if (isUnionSlot(a) && isUnionSlot(b)) {
    if (a.union.length !== b.union.length) return false;
    return a.union.every((s, i) => slotsEqual(s, b.union[i]!));
  }
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
   * The extracted signatures. A ctor with no optional/defaulted params yields
   * one; each trailing optional or defaulted param adds a shorter "without that
   * arg" overload (see `withOptionalOverloads`).
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
  if (!resolved) return undefined;

  const classDecl = classDeclarationOf(resolved);
  if (!classDecl) return undefined;

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
 * Extract the constructor signatures from a class declaration. A class with no
 * explicit constructor (or an explicit zero-parameter one) yields a single empty
 * signature `[[]]`. Each trailing optional or defaulted parameter adds a shorter
 * "without that arg" overload (see `withOptionalOverloads`). Parameter properties
 * and modifiers are irrelevant — only the parameter TYPES drive token derivation.
 */
export function extractSignatureFromClass(
  classDecl: ts.ClassDeclaration,
  ctx: DepContext,
): Signature[] {
  const ctor = findConstructor(classDecl);
  if (!ctor) return [[]];

  const slots = ctor.parameters.map((param) => extractParamSlot(param, ctx));
  return withOptionalOverloads(slots, trailingOptionalCount(ctor.parameters, ctx));
}

/**
 * Classify a single constructor parameter into a slot.
 *
 * Priority order:
 *   1. `ResolveScope`-typed → ScopeSlot (live scope injection).
 *   2. `Inject<T, "tok">` brand on the type → the branded token string.
 *   3. Inline function-type annotation (`() => IFoo`) → FactorySlot (PRD §7).
 *   4. Inline union type annotation (`A | B`, NOT `T | undefined`) → UnionSlot.
 *   5. Normal type → string token via `tokenForType`.
 *   6. No derivable token + no brand → hard diagnostic (UnderivableToken).
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
  if (isResolveScopeParam(param, ctx)) return { scope: true };

  // 2. Check for the Inject<T, "tok"> brand FIRST, before factory / union /
  //    normal derivation. If branded, the branded token wins unconditionally.
  const rawType = ctx.checker.getTypeAtLocation(param);
  const brandedToken = injectTokenFor(rawType, ctx.checker);
  if (brandedToken !== undefined) return brandedToken;

  // 3. Inline factory (syntactic: annotation is a FunctionTypeNode).
  const factory = factorySlotFor(param, ctx);
  if (factory) return factory;

  // 4. Inline union (syntactic: annotation is a UnionTypeNode, but NOT T|undefined).
  //    Named type aliases that expand to a union are TypeReferenceNodes at the
  //    annotation site — they naturally fall through to step 5.
  const typeNode = param.type;
  if (typeNode && ts.isUnionTypeNode(typeNode)) {
    // Filter out the `| undefined` optionality marker.
    // In the AST, `| undefined` appears as a keyword TypeNode with kind
    // `UndefinedKeyword`. If after filtering there is only one member, this is
    // the `T | undefined` optional-param path — fall through to step 5
    // (nonNullish strips undefined from the resolved type).
    const nonUndefinedMembers = typeNode.types.filter(
      (t) => t.kind !== ts.SyntaxKind.UndefinedKeyword,
    );

    // Only treat as a union slot when two or more non-undefined members remain.
    if (nonUndefinedMembers.length >= 2) {
      // Recursively lower each member through a synthetic param-like context.
      const memberSlots = nonUndefinedMembers.map((memberTypeNode) =>
        extractParamSlotFromTypeNode(memberTypeNode, param, ctx),
      );
      return { union: memberSlots };
    }
  }

  // 5. Normal derivation. Strip a `| undefined` (the optionality marker) so
  //    `dep?: IFoo` derives `IFoo`'s token.
  const type = nonNullish(rawType);
  const result = tokenForType(type, ctx);
  if (result !== undefined) return result.token;

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
  if (brandedToken !== undefined) return brandedToken;

  // Nested factory: an inline function type node within a union member.
  if (ts.isFunctionTypeNode(typeNode)) {
    const signature = ctx.checker.getSignatureFromDeclaration(typeNode);
    if (signature) {
      const token = tokenForReturnType(signature, ctx);
      if (token !== undefined) return { type: token };
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

  // Normal derivation.
  const token = deriveTokenForTypeNode(typeNode, ctx);
  if (token !== undefined) return token;

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
  const slots = fn.parameters.map((param) => extractParamSlot(param, ctx));
  return withOptionalOverloads(slots, trailingOptionalCount(fn.parameters, ctx));
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
  const slots: Slot[] = [];
  const params: ts.ParameterDeclaration[] = [];
  for (const paramSymbol of signature.parameters) {
    const decl = paramSymbol.valueDeclaration;
    if (!decl || !ts.isParameter(decl) || decl.dotDotDotToken) return undefined;
    slots.push(extractParamSlot(decl, ctx));
    params.push(decl);
  }
  return withOptionalOverloads(slots, trailingOptionalCount(params, ctx));
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
  if (type.getConstructSignatures().length > 0) return undefined;
  const callSignatures = type.getCallSignatures();
  if (callSignatures.length === 0) return undefined;
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
  if (constructSignatures.length === 0) return undefined;
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
  if (!typeNode || !ts.isFunctionTypeNode(typeNode)) return undefined;

  const signature = ctx.checker.getSignatureFromDeclaration(typeNode);
  if (!signature) return undefined;

  const token = tokenForReturnType(signature, ctx);
  if (token === undefined) return undefined;
  return { type: token };
}

/** The first constructor declaration WITH a body (the implementation). */
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

// ── optionality + overload expansion ─────────────────────────────────────────

/**
 * Expand a base slot list into one or more signatures: the full list, plus one
 * shorter signature for each trailing optional/defaulted param dropped from the
 * right. Longest first, so greedy resolve-time selection prefers injecting the
 * optional dep and falls back to the shorter constructor (default param / an
 * `undefined` argument) only when the dep is not registered.
 *
 *   (a: IA, dep?: IFoo)            → [[IA, IFoo], [IA]]
 *   (a: IA, prefix: string = "x") → [[IA, null], [IA]]
 *   (name: string)                → [[null]]            (required hole, no drop)
 */
function withOptionalOverloads(
  slots: Slot[],
  trailingOptional: number,
): Signature[] {
  const signatures: Signature[] = [];
  for (let drop = 0; drop <= trailingOptional; drop++) {
    signatures.push(slots.slice(0, slots.length - drop));
  }
  return signatures;
}

/** The length of the trailing run of optional/defaulted params (droppable). */
function trailingOptionalCount(
  params: readonly ts.ParameterDeclaration[],
  ctx: TokenContext,
): number {
  let count = 0;
  for (let i = params.length - 1; i >= 0; i--) {
    if (!isOptionalParam(params[i]!, ctx)) break;
    count++;
  }
  return count;
}

/**
 * True when a parameter is optional — a `?` token, a default initializer, or a
 * type that admits `undefined` (`dep: IFoo | undefined`). Such a param can be
 * omitted at the call site, so it earns a "without that arg" overload.
 */
function isOptionalParam(
  param: ts.ParameterDeclaration,
  ctx: TokenContext,
): boolean {
  if (param.questionToken !== undefined || param.initializer !== undefined) {
    return true;
  }
  return typeIncludesUndefined(ctx.checker.getTypeAtLocation(param));
}

/** True when a type is `undefined` or a union with an `undefined` member. */
function typeIncludesUndefined(type: ts.Type): boolean {
  if (type.flags & ts.TypeFlags.Undefined) return true;
  return (
    type.isUnion() &&
    type.types.some((t) => t.flags & ts.TypeFlags.Undefined)
  );
}

/**
 * Strip `undefined` / `null` / `void` from a union, returning the sole surviving
 * member when exactly one remains (`IFoo | undefined` → `IFoo`). A union with
 * multiple non-nullish members is returned unchanged — `deriveToken` handles it
 * (a literal union renders its token; a typed union resolves by alias or holes).
 */
function nonNullish(type: ts.Type): ts.Type {
  if (!type.isUnion()) return type;
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
  if (!decorators) return false;
  return decorators.some((d) => decoratorName(d) === "signature");
}

function decoratorName(decorator: ts.Decorator): string | undefined {
  const expr = decorator.expression;
  if (ts.isCallExpression(expr)) {
    const callee = expr.expression;
    if (ts.isIdentifier(callee)) return callee.text;
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  }
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return undefined;
}
