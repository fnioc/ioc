// Constructor dependency extraction (PRD §8 "Dep extraction").
//
// Given a concrete class's constructor, read each parameter's type via the
// TypeChecker and compute one token per parameter:
//   - primitives / any / unknown / void  →  `null` (a hole)
//   - `Promise<X>`                        →  the token for `X`
//   - everything else                     →  a string token
// The result is ONE signature (a positional array), matching the single
// canonical ctor the transformer sees statically. The runtime decides at
// resolve time whether a `null` is a genuine hole or an error.

import ts from "typescript";
import { tokenForType, type TokenContext } from "./tokens.js";

/** One emitted signature: positional tokens, `null` for holes. */
export type Signature = ReadonlyArray<string | null>;

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

  const tokens: Array<string | null> = [];
  for (const param of ctor.parameters) {
    const type = ctx.checker.getTypeAtLocation(param);
    // Phase 2D: a parameter literally typed `() => IFoo` / `(a, b) => IFoo`
    // becomes a FACTORY marker in the emitted signature. For this phase a
    // function-typed param is treated like any other type (token or null) —
    // an arrow type has no symbol, so `tokenForType` already yields a hole.
    const result = tokenForType(type, ctx);
    tokens.push(result.kind === "hole" ? null : result.token);
  }
  return tokens;
}

/** The first constructor declaration WITH a body (the implementation). */
function findConstructor(
  classDecl: ts.ClassDeclaration,
): ts.ConstructorDeclaration | undefined {
  const ctors = classDecl.members.filter(ts.isConstructorDeclaration);
  return ctors.find((c) => c.body !== undefined) ?? ctors[0];
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
