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

/** One positional slot: a token string, `null` for a hole, or a factory ref. */
export type Slot = string | null | FactorySlot;

/** One emitted signature: positional slots (token / hole / factory). */
export type Signature = ReadonlyArray<Slot>;

/** True when a slot is a factory ref rather than a plain token / hole. */
export function isFactorySlot(slot: Slot): slot is FactorySlot {
  return typeof slot === "object" && slot !== null;
}

export interface ConstructorExtraction {
  /** The class symbol the constructor belongs to. */
  readonly classSymbol: ts.Symbol;
  /** The single extracted signature. */
  readonly signature: Signature;
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

  const signature = extractSignatureFromClass(classDecl, ctx);
  return { classSymbol: resolved, signature };
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
 * Extract the constructor signature from a class declaration. A class with no
 * explicit constructor (or an explicit zero-parameter one) yields an empty
 * signature `[]`. Parameter properties and modifiers are irrelevant — only the
 * parameter TYPES drive token derivation.
 */
export function extractSignatureFromClass(
  classDecl: ts.ClassDeclaration,
  ctx: TokenContext,
): Signature {
  const ctor = findConstructor(classDecl);
  if (!ctor) return [];

  const slots: Slot[] = [];
  for (const param of ctor.parameters) {
    slots.push(extractParamSlot(param, ctx));
  }
  return slots;
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
  const factory = factorySlotFor(param, ctx);
  if (factory) return factory;

  const type = ctx.checker.getTypeAtLocation(param);
  const result = tokenForType(type, ctx);
  return result.kind === "hole" ? null : result.token;
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
  const type = ctx.checker.getTypeAtLocation(param);
  const result = tokenForType(type, ctx);
  return result.kind === "hole" ? null : result.token;
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
