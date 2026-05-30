// Registration lowering + `defineDeps` emission (PRD §8).
//
// Authored:   services.add<IUserRepo>(SqlUserRepo).as<"request">();
// Lowered:    defineDeps(SqlUserRepo, [["pkg:ILogger", "pkg:IDbConnection", null]]);
//             services.add("pkg:IUserRepo", SqlUserRepo).as("request");
//
// Two rewrites happen per registration:
//   1. `add<I>(C)` → `add("<token-for-I>", C)`  (type arg lowered to a string
//      literal, prepended before the concrete value arg; type arg dropped).
//   2. `.as<"x">()` → `.as("x")`                (string-literal type arg lowered
//      to a value arg; type arg dropped). Any fluent `.as` in the chain.
//
// And one insertion: a `defineDeps(C, [[...]])` statement immediately before the
// registration statement — unless the class is already manually annotated (skip
// + info diagnostic) or the concrete arg is dynamic (skip the dep array; the
// runtime throws with guidance — that is @fnioc/di's job).

import ts from "typescript";
import { deriveToken, type TokenContext } from "./tokens.js";
import {
  extractFromExpression,
  hasSignatureDecorator,
  isFactorySlot,
  type Signature,
  type Slot,
} from "./deps.js";
import {
  checkAnnotatedFactoryParams,
  checkExtractedRegistration,
  checkOverloads,
  type CheckContext,
} from "./checks.js";
import {
  DiagnosticCode,
  info,
  type DiagnosticSink,
} from "./diagnostics.js";

export interface LowerContext extends CheckContext {
  readonly factory: ts.NodeFactory;
  readonly sink: DiagnosticSink;
  readonly sourceFile: ts.SourceFile;
  /** Class declarations annotated via a `forCtor(C)` call in this file. */
  readonly forCtorAnnotated: ReadonlySet<ts.Symbol>;
  /**
   * Mint a fresh identifier for an emitted `defineDeps(...)` call. Each call
   * gets its OWN identifier node (a node may appear once in the tree), but all
   * are linked to the same injected import specifier so the downstream module
   * transformer rewrites them consistently with the import in BOTH ESM (bare
   * `defineDeps(...)`) and CJS (`core_1.defineDeps(...)`) output. A plain
   * `createIdentifier` would dangle in CJS, where the named import becomes a
   * namespace property access.
   */
  makeDefineDepsRef(): ts.Identifier;
  /** Set true whenever a registration is lowered (so we inject the import). */
  markUsedDefineDeps(): void;
}

/**
 * If `statement` is an expression statement containing one or more registration
 * chains, return the lowered statement plus any `defineDeps(...)` statements to
 * insert before it. Returns `undefined` when the statement is not a
 * registration (the caller leaves it untouched).
 */
export function lowerStatement(
  statement: ts.Statement,
  ctx: LowerContext,
): ts.Statement[] | undefined {
  if (!ts.isExpressionStatement(statement)) return undefined;

  const registrations = findRegistrationCalls(statement.expression);
  if (registrations.length === 0) return undefined;

  const preludes: ts.Statement[] = [];
  for (const reg of registrations) {
    const prelude = buildDefineDeps(reg, ctx);
    if (prelude) preludes.push(prelude);
  }

  const loweredExpr = lowerExpression(statement.expression, ctx);
  const loweredStatement = ctx.factory.updateExpressionStatement(
    statement,
    loweredExpr,
  );

  return [...preludes, loweredStatement];
}

/** A detected `X.add<I>(C)` registration call (the concrete-arg expression). */
interface Registration {
  readonly concreteArg: ts.Expression;
}

/** True when `call` is a `*.add<I>(C, ...)` with exactly one type argument. */
function isAddRegistration(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (callee.name.text !== "add") return false;
  if (!call.typeArguments || call.typeArguments.length !== 1) return false;
  if (call.arguments.length < 1) return false;
  return true;
}

/** True when `call` is a `*.as<"x">()` fluent scope tag. */
function isAsCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (callee.name.text !== "as") return false;
  if (!call.typeArguments || call.typeArguments.length !== 1) return false;
  return true;
}

/** Collect every `add<I>(C)` registration call reachable within `expr`. */
function findRegistrationCalls(expr: ts.Node): Registration[] {
  const found: Registration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isAddRegistration(node)) {
      found.push({ concreteArg: node.arguments[0]! });
    }
    ts.forEachChild(node, visit);
  };
  visit(expr);
  return found;
}

/**
 * Build the `defineDeps(C, [[...]])` statement for a registration, applying the
 * already-annotated and dynamic-registration rules. Returns `undefined` when no
 * statement should be emitted (annotated → skip + diagnostic; dynamic → skip).
 */
function buildDefineDeps(
  reg: Registration,
  ctx: LowerContext,
): ts.Statement | undefined {
  const extraction = extractFromExpression(reg.concreteArg, ctx);

  // Dynamic registration: concrete arg does not resolve to a static class.
  // Emit no dep array; @fnioc/di throws with guidance at resolve time. No
  // diagnostic here — a dynamic factory/value registration is a legitimate
  // pattern, and the runtime owns the "has params but no metadata" error.
  if (!extraction) return undefined;

  // Equal-arity overload ambiguity runs for every registration, including
  // manually-annotated ones (overloads only ever come from stacked @signature /
  // chained forCtor, which the annotated path below skips for emission).
  checkOverloads(extraction.classSymbol, reg.concreteArg, ctx);

  // Already-annotated: a manual `@signature` / `forCtor` is authoritative.
  // Skip emission and surface an info diagnostic (never silent, never
  // double-write).
  const classDecl = extraction.classSymbol
    .getDeclarations()
    ?.find(ts.isClassDeclaration);
  const annotated =
    (classDecl && hasSignatureDecorator(classDecl)) ||
    ctx.forCtorAnnotated.has(extraction.classSymbol);
  if (annotated) {
    // The manual annotation governs the emitted signature, but PRD §8 still
    // validates factory parameters declared on the hand-annotated ctor against
    // the produced type's constructor holes — a hand-authored factory slot with
    // a bad signature must not ship without a diagnostic.
    checkAnnotatedFactoryParams(extraction.classSymbol, ctx);
    ctx.sink.addDiagnostic(
      info(
        ctx.sourceFile,
        reg.concreteArg,
        DiagnosticCode.AlreadyAnnotated,
        `${extraction.classSymbol.getName()} already has a manual @signature/forCtor annotation; ` +
          `skipping transformer-generated defineDeps (manual annotation is authoritative).`,
      ),
    );
    return undefined;
  }

  // Validate the extracted ctor where statically visible: factory call
  // signatures against the produced ctor's unregistered params (PRD §4.5) and
  // the bare-`IDb`-vs-`Promise<IDb>` async mismatch.
  checkExtractedRegistration(extraction, ctx);

  ctx.markUsedDefineDeps();
  return defineDepsStatement(
    reg.concreteArg,
    extraction.signature,
    ctx.factory,
    ctx.makeDefineDepsRef(),
  );
}

/** Render `<defineDepsRef>(<ctorExpr>, [[...signature]]);` as a statement. */
function defineDepsStatement(
  ctorExpr: ts.Expression,
  signature: Signature,
  factory: ts.NodeFactory,
  defineDepsRef: ts.Identifier,
): ts.Statement {
  const slotLiterals = signature.map((slot) => slotLiteral(slot, factory));
  const signatureArray = factory.createArrayLiteralExpression(
    [factory.createArrayLiteralExpression(slotLiterals, false)],
    false,
  );
  const call = factory.createCallExpression(defineDepsRef, undefined, [
    cloneExpression(ctorExpr, factory),
    signatureArray,
  ]);
  return factory.createExpressionStatement(call);
}

/**
 * Render one signature slot as its emitted literal: `null` for a hole, a string
 * literal for a token, and a `{ factory: "<token>" }` object literal for a
 * factory ref (the `FactoryRef` ABI shape the di runtime partitions at resolve
 * time).
 */
function slotLiteral(slot: Slot, factory: ts.NodeFactory): ts.Expression {
  if (slot === null) return factory.createNull();
  if (isFactorySlot(slot)) {
    return factory.createObjectLiteralExpression(
      [
        factory.createPropertyAssignment(
          "factory",
          factory.createStringLiteral(slot.factory),
        ),
      ],
      false,
    );
  }
  return factory.createStringLiteral(slot);
}

/**
 * Lower the registration expression: rewrite every `add<I>(C)` to
 * `add("token", C)` and every `.as<"x">()` to `.as("x")`, recursively.
 */
function lowerExpression(expr: ts.Expression, ctx: LowerContext): ts.Expression {
  const visit = (node: ts.Node): ts.Node => {
    const visited = ts.visitEachChild(node, visit, undefined);

    if (ts.isCallExpression(visited)) {
      if (isAddRegistration(visited)) {
        return lowerAddCall(visited, ctx);
      }
      if (isAsCall(visited)) {
        return lowerAsCall(visited, ctx.factory);
      }
    }
    return visited;
  };
  return visit(expr) as ts.Expression;
}

/** `add<I>(C, ...)` → `add("<token-for-I>", C, ...)` (type arg dropped). */
function lowerAddCall(call: ts.CallExpression, ctx: LowerContext): ts.CallExpression {
  const typeArg = call.typeArguments![0]!;
  const token = tokenForTypeNode(typeArg, ctx);
  const tokenLiteral =
    token === undefined
      ? ctx.factory.createNull()
      : ctx.factory.createStringLiteral(token);

  return ctx.factory.updateCallExpression(
    call,
    call.expression,
    undefined, // drop the type argument
    [tokenLiteral, ...call.arguments],
  );
}

/** `.as<"x">()` → `.as("x")` (string-literal type arg lowered to a value arg). */
function lowerAsCall(call: ts.CallExpression, factory: ts.NodeFactory): ts.CallExpression {
  const typeArg = call.typeArguments![0]!;
  let literal: ts.Expression;
  if (ts.isLiteralTypeNode(typeArg) && ts.isStringLiteral(typeArg.literal)) {
    literal = factory.createStringLiteral(typeArg.literal.text);
  } else {
    // Non-string-literal scope type. There's no runtime value to synthesize, so
    // just drop the type argument and keep any existing value args. Scope tags
    // are always string literals in the authored API, so this is defensive.
    return factory.updateCallExpression(call, call.expression, undefined, [
      ...call.arguments,
    ]);
  }
  return factory.updateCallExpression(call, call.expression, undefined, [
    literal,
    ...call.arguments,
  ]);
}

/** Resolve a `<I>` type-argument node to its token string. */
function tokenForTypeNode(
  typeNode: ts.TypeNode,
  ctx: LowerContext,
): string | undefined {
  const type = ctx.checker.getTypeFromTypeNode(typeNode);
  return deriveToken(type, ctx);
}

/**
 * Reproduce a (simple) ctor reference expression for the `defineDeps` call.
 * Registration concrete args are plain identifiers or property-access chains;
 * we reconstruct those rather than reuse the original node, which still belongs
 * to the (separately rewritten) registration call's subtree.
 */
function cloneExpression(expr: ts.Expression, factory: ts.NodeFactory): ts.Expression {
  if (ts.isIdentifier(expr)) return factory.createIdentifier(expr.text);
  if (ts.isPropertyAccessExpression(expr)) {
    return factory.createPropertyAccessExpression(
      cloneExpression(expr.expression, factory),
      expr.name.text,
    );
  }
  // Fallback: any other expression form is reused directly. The printer emits
  // its text; sharing the node is safe because lowering replaces the `add`
  // call wholesale rather than mutating the concrete arg in place.
  return expr;
}
