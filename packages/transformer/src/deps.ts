// Constructor dependency extraction (PRD §8 "Dep extraction"; §7 factories).
//
// Given a concrete class's constructor, read each parameter's type via the
// TypeChecker and compute one slot per parameter:
//   - primitives / any / unknown / void   →  `null` (a hole)
//   - `Promise<X>`                         →  the token for `X`
//   - an inline function type `() => IFoo` →  a factory ref { factory: token-of-IFoo }
//   - everything else                      →  a string token
// The result is ONE signature (a positional array), matching the single
// canonical ctor the transformer sees statically. The runtime decides at
// resolve time whether a `null` is a genuine hole or an error, and partitions a
// factory's call args against the live registration map.

import ts from "typescript";
import {
  tokenForType,
  tokenForReturnType,
  type TokenContext,
} from "./tokens.js";

/**
 * A factory slot in an extracted signature — the transformer's in-memory mirror
 * of the runtime `FactoryRef` shape. Emitted as a `{ factory: "<token>" }`
 * object literal in the `defineDeps(...)` signature array.
 */
export interface FactorySlot {
  readonly factory: string;
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
 * One positional slot: a token string, `null` for a hole, a factory ref, or a
 * scope ref.
 */
export type Slot = string | null | FactorySlot | ScopeSlot;

/** One emitted signature: positional slots (token / hole / factory / scope). */
export type Signature = ReadonlyArray<Slot>;

/** True when a slot is a factory ref rather than a plain token / hole / scope. */
export function isFactorySlot(slot: Slot): slot is FactorySlot {
  return (
    typeof slot === "object" &&
    slot !== null &&
    typeof (slot as { factory?: unknown }).factory === "string"
  );
}

/** True when a slot is a scope ref (`{ scope: true }`). */
export function isScopeSlot(slot: Slot): slot is ScopeSlot {
  return (
    typeof slot === "object" &&
    slot !== null &&
    (slot as { scope?: unknown }).scope === true
  );
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
 * Resolve the class a registration's concrete-argument expression refers to and
 * extract its constructor signature. Returns `undefined` when the expression
 * does not statically resolve to a class with a declaration (a dynamic
 * registration — the caller emits no dep array and warns).
 */
export function extractFromExpression(
  expr: ts.Expression,
  ctx: TokenContext,
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
  ctx: TokenContext,
): Signature[] {
  const ctor = findConstructor(classDecl);
  if (!ctor) return [[]];

  const slots = ctor.parameters.map((param) => extractParamSlot(param, ctx));
  return withOptionalOverloads(slots, trailingOptionalCount(ctor.parameters, ctx));
}

/**
 * Classify a single constructor parameter into a slot.
 *
 * Factory discriminator (PRD §7, syntactic):
 *   - The parameter's type ANNOTATION is an inline function-type literal
 *     (`() => IFoo`, `(a: B, b: D) => IFoo`) — a `ts.FunctionTypeNode` — so it
 *     becomes a factory ref keyed on the return type's token.
 *   - A NAMED type reference (`thunk: IFooThunk`, even when `IFooThunk` is a
 *     callable function-interface) is NOT a factory — it resolves to the named
 *     type's own token. This is the deliberate opt-out: name the interface to
 *     escape factory interpretation.
 *
 * Detection is purely on the syntactic shape of the annotation, never on the
 * resolved type — the resolved `ts.Type` of an inline arrow and of a named
 * callable interface are structurally identical, so only the syntax tells them
 * apart.
 */
function extractParamSlot(
  param: ts.ParameterDeclaration,
  ctx: TokenContext,
): Slot {
  // A `ResolveScope`-typed parameter is the live scope, not a token. Checked
  // first so it wins over the structural token/factory reads below.
  if (isResolveScopeParam(param, ctx)) return { scope: true };

  const factory = factorySlotFor(param, ctx);
  if (factory) return factory;

  // Strip a `| undefined` (the optionality marker) so `dep?: IFoo` derives
  // `IFoo`'s token — the param is made optional via a "without that arg"
  // overload (`withOptionalOverloads`), not by holing the dep.
  const type = nonNullish(ctx.checker.getTypeAtLocation(param));
  const result = tokenForType(type, ctx);
  return result.kind === "hole" ? null : result.token;
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
 * function literal's parameters — each becomes a token / hole / factory ref /
 * scope ref via the same per-parameter classifier.
 */
export function extractSignatureFromFunction(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  ctx: TokenContext,
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
  ctx: TokenContext,
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
  ctx: TokenContext,
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
  ctx: TokenContext,
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
  return { factory: token };
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
 * The token (or hole `null`) a single inline-factory parameter resolves to —
 * used by the §4.5 diagnostic to compare a factory's declared call signature
 * against the produced ctor's unregistered params. Mirrors `extractParamSlot`'s
 * non-factory branch (a nested inline factory param collapses to its own
 * token via `tokenForType`'s structural read, which is acceptable for the
 * shallow positional comparison the diagnostic performs).
 */
export function slotForParam(
  param: ts.ParameterDeclaration,
  ctx: TokenContext,
): string | null {
  const type = nonNullish(ctx.checker.getTypeAtLocation(param));
  const result = tokenForType(type, ctx);
  return result.kind === "hole" ? null : result.token;
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
