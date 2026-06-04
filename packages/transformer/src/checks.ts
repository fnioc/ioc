// Compile-time registration checks (PRD §4.5 / §8 "Factory-signature diagnostic").
//
// The transformer's primary value-add: clear, instructive feedback when a
// registration's static shape can't line up with what the container will do at
// resolve time. Three checks, all conservative — they fire ONLY where the
// mismatch is statically certain, never on a guess:
//
//   1. Factory-signature mismatch (§4.5). An inline-factory ctor param
//      `(b: B2, d: D4) => IFoo` must list, in order, the unregistered (hole)
//      params of IFoo's concrete constructor. When that concrete ctor is
//      statically reachable, compare arities and warn on a count mismatch (the
//      check is arity-only — it does not compare per-position types).
//   2. Async mismatch. A ctor param declared as a bare `IDb` for a token that
//      is registered async (a `useFactory` whose result is a `Promise`) — the
//      value is a `Promise<IDb>`, so the dep should be declared `Promise<IDb>`.
//   3. Equal-arity overload ambiguity. Two manual `@signature` / `forCtor`
//      signatures of the same length for one constructor — the engine can't
//      tell them apart by arity.

import ts from "typescript";
import {
  classDeclarationOfType,
  findConstructor,
  slotForParam,
  type ConstructorExtraction,
} from "./deps.js";
import {
  tokenForType,
  deriveToken,
  intrinsicToken,
  singletonValue,
  type TokenContext,
} from "./tokens.js";
import {
  DiagnosticCode,
  warning,
  type DiagnosticSink,
} from "./diagnostics.js";

export interface CheckContext extends TokenContext {
  readonly sink: DiagnosticSink;
  readonly sourceFile: ts.SourceFile;
  /** Tokens registered with an async (`Promise`-returning) `useFactory`. */
  readonly asyncTokens: ReadonlySet<string>;
}

/**
 * The factory-signature (§4.5) and async-mismatch checks for a class the
 * transformer extracts a signature from (i.e. NOT a manually-annotated class —
 * those carry their own author-supplied signatures). Each check is independently
 * best-effort: an un-resolvable shape is skipped, never flagged.
 */
export function checkExtractedRegistration(
  extraction: ConstructorExtraction,
  ctx: CheckContext,
): void {
  const classDecl = extraction.classSymbol
    .getDeclarations()
    ?.find(ts.isClassDeclaration);
  if (!classDecl) {return;}

  const ctor = findConstructor(classDecl);
  if (!ctor) {return;}

  for (const param of ctor.parameters) {
    checkFactoryParam(param, ctx);
    checkAsyncParam(param, ctx);
  }
}

/**
 * Factory-signature (§4.5) check for a manually-annotated class (`@signature` /
 * `forCtor`). The annotated path skips dep extraction and `defineDeps` emission,
 * so `checkExtractedRegistration` never runs for it — but PRD §8 still requires
 * factory parameters declared on a hand-annotated ctor to be validated against
 * the produced type's constructor holes. This runs ONLY the factory-signature
 * check (not the async-mismatch one, which keys off transformer-derived tokens
 * the author has overridden by annotating). Each param is independently
 * best-effort: an un-resolvable shape is skipped, never flagged.
 */
export function checkAnnotatedFactoryParams(
  classSymbol: ts.Symbol,
  ctx: CheckContext,
): void {
  const classDecl = classSymbol
    .getDeclarations()
    ?.find(ts.isClassDeclaration);
  if (!classDecl) {return;}

  const ctor = findConstructor(classDecl);
  if (!ctor) {return;}

  for (const param of ctor.parameters) {
    checkFactoryParam(param, ctx);
  }
}

/**
 * Equal-arity overload-ambiguity check. Runs for EVERY registration, including
 * manually-annotated ones — overloads only ever come from stacked `@signature`
 * decorators or chained `forCtor(...).signature(...)`, which the transformer
 * skips for emission but must still validate.
 */
export function checkOverloads(
  classSymbol: ts.Symbol,
  site: ts.Expression,
  ctx: CheckContext,
): void {
  const classDecl = classSymbol
    .getDeclarations()
    ?.find(ts.isClassDeclaration);
  if (!classDecl) {return;}
  checkOverloadAmbiguity(classDecl, site, ctx);
}

/**
 * §4.5: an inline-factory param's declared call signature vs. the produced
 * concrete ctor's caller-supplied (hole) params. Only fires when the produced
 * type resolves to a concrete class whose constructor we can read.
 *
 * Relaxed rule (caller-supplied-as-override): declared params must COVER the
 * produced ctor's primitive-scalar holes (params that are intrinsic / literal /
 * anonymous — the container cannot resolve them), but MAY additionally include
 * named-interface/class params that ARE registered. Those extra declared params
 * are meaningful overrides: the transformer emits them as `FactoryRef.params` and
 * the runtime honours "caller wins over registration" for any token named in
 * params. Only warn when declared params FAIL to cover the holes (i.e. a hole
 * exists that the caller did not declare and cannot override with a registration).
 */
function checkFactoryParam(
  param: ts.ParameterDeclaration,
  ctx: CheckContext,
): void {
  const typeNode = param.type;
  if (!typeNode || !ts.isFunctionTypeNode(typeNode)) {return;}

  const signature = ctx.checker.getSignatureFromDeclaration(typeNode);
  if (!signature) {return;}

  // The produced concrete class (the factory's product). The return type is
  // usually an interface; we can only check when a concrete class is reachable.
  const returnType = ctx.checker.getReturnTypeOfSignature(signature);
  const producedClass = concreteClassFor(returnType, ctx);
  if (!producedClass) {return;}

  const producedCtor = findConstructor(producedClass);
  if (!producedCtor) {return;}

  // The produced ctor's caller-supplied (hole) params — primitive scalars the
  // container cannot resolve. Under Rule 1 every named type tokenizes, so a
  // "hole" is a PRIMITIVE SCALAR: a bare intrinsic keyword (`string`/`number`/…),
  // a singular literal value (Rule 2), or an anonymous structure with no token.
  // A real DI service (named interface/class) is container-resolved, not a hole.
  const holes = producedCtor.parameters.filter((p) =>
    isCallerSuppliedParam(p, ctx),
  );

  // The factory's own declared params.
  const declared = typeNode.parameters;

  // Warn only when declared params don't cover the holes. Extra declared params
  // beyond the hole count are fine: they name named-service overrides (caller
  // wins). But the number of declared params must be AT LEAST the number of holes
  // (every hole must be covered), and total declared count must not EXCEED the
  // total ctor param count (can't invent slots).
  const holeCount = holes.length;
  const declaredCount = declared.length;
  const ctorParamCount = producedCtor.parameters.length;

  const bad = declaredCount < holeCount || declaredCount > ctorParamCount;
  if (bad) {
    const name = param.name.getText();
    ctx.sink.addDiagnostic(
      warning(
        ctx.sourceFile,
        typeNode,
        DiagnosticCode.FactorySignatureMismatch,
        `Factory parameter "${name}" declares ${declaredCount} argument(s), but ` +
          `the produced constructor has ${holeCount} caller-supplied hole(s) and ` +
          `${ctorParamCount} total slot(s). Declared params must cover all holes ` +
          `and may additionally name registered-service overrides (caller wins), ` +
          `but cannot exceed the total slot count.`,
      ),
    );
  }
}

/**
 * True when a produced-ctor parameter is CALLER-SUPPLIED at a parameterized
 * factory boundary (a §4.5 "hole"). Under Rule 1 every named type tokenizes, so
 * this is no longer "underivable" — it is a PRIMITIVE SCALAR the container does
 * not provide:
 *   - a singular literal (Rule 2 — its value is caller/registration data),
 *   - a bare intrinsic keyword token (`string` / `number` / `boolean` / …), or
 *   - an anonymous structure with no token at all.
 * A param whose type is a named interface/class (a real DI service) is
 * container-resolved, so it is NOT caller-supplied.
 */
function isCallerSuppliedParam(
  param: ts.ParameterDeclaration,
  ctx: CheckContext,
): boolean {
  const type = ctx.checker.getTypeAtLocation(param);
  if (singletonValue(type) !== undefined) {return true;}
  if (intrinsicToken(type) !== undefined) {return true;}
  return slotForParam(param, ctx) === null;
}

/**
 * Async mismatch: a ctor param declared as a bare token whose service is
 * registered async (`useFactory` returning a `Promise`). The container hands
 * back the `Promise` verbatim, so the dep must be declared `Promise<T>`.
 * Skipped for params already declared `Promise<...>`.
 */
function checkAsyncParam(
  param: ts.ParameterDeclaration,
  ctx: CheckContext,
): void {
  const typeNode = param.type;
  // Already `Promise<...>` → correct, nothing to flag.
  if (typeNode && isPromiseTypeNode(typeNode)) {return;}
  // Inline factory params are not direct deps — skip.
  if (typeNode && ts.isFunctionTypeNode(typeNode)) {return;}

  const type = ctx.checker.getTypeAtLocation(param);
  const result = tokenForType(type, ctx);
  if (result === undefined) {return;}

  if (!ctx.asyncTokens.has(result.token)) {return;}

  const name = param.name.getText();
  ctx.sink.addDiagnostic(
    warning(
      ctx.sourceFile,
      typeNode ?? param,
      DiagnosticCode.AsyncMismatch,
      `Dependency "${name}" is registered async, so the container returns a ` +
        `Promise. Declare it as Promise<${producedName(type, ctx)}> and await ` +
        `it where you use it.`,
    ),
  );
}

/**
 * Equal-arity overload ambiguity: two manual `@signature` / `forCtor`
 * signatures of the same length on one constructor. The engine selects
 * overloads by arity, so two same-length signatures it cannot disambiguate.
 */
function checkOverloadAmbiguity(
  classDecl: ts.ClassDeclaration,
  site: ts.Expression,
  ctx: CheckContext,
): void {
  const decorators = ts.getDecorators(classDecl) ?? [];
  const lengths: number[] = [];
  for (const dec of decorators) {
    if (!ts.isCallExpression(dec.expression)) {continue;}
    if (!isSignatureCallee(dec.expression.expression)) {continue;}
    lengths.push(dec.expression.arguments.length);
  }
  // forCtor(C).signature(a, b).signature(c, d) — chained signature() arities.
  for (const len of forCtorSignatureArities(classDecl, ctx)) {lengths.push(len);}

  const seen = new Set<number>();
  for (const len of lengths) {
    if (seen.has(len)) {
      ctx.sink.addDiagnostic(
        warning(
          ctx.sourceFile,
          site,
          DiagnosticCode.OverloadAmbiguity,
          `${classDecl.name?.text ?? "This class"} has two constructor ` +
            `signatures of the same length (${len}). The container picks an ` +
            `overload by argument count, so it cannot tell them apart. Give ` +
            `them different lengths.`,
        ),
      );
      return;
    }
    seen.add(len);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Resolve a type to its concrete (instantiable) class declaration, if any. */
function concreteClassFor(
  type: ts.Type,
  ctx: CheckContext,
): ts.ClassDeclaration | undefined {
  const direct = classDeclarationOfType(type);
  if (direct) {return direct;}
  // A `Promise<X>` factory product: unwrap and retry on X.
  const symbol = type.getSymbol();
  if (symbol?.getName() === "Promise") {
    const args = ctx.checker.getTypeArguments(type as ts.TypeReference);
    if (args.length === 1) {return classDeclarationOfType(args[0]!);}
  }
  return undefined;
}

/** A best-effort display name for the produced type (for the async message). */
function producedName(type: ts.Type, ctx: CheckContext): string {
  const unwrapped = unwrapPromiseType(type, ctx);
  return deriveToken(unwrapped, ctx)?.replace(/^.*[:/]/, "") ?? "T";
}

function unwrapPromiseType(type: ts.Type, ctx: CheckContext): ts.Type {
  const symbol = type.getSymbol();
  if (symbol?.getName() === "Promise") {
    const args = ctx.checker.getTypeArguments(type as ts.TypeReference);
    if (args.length === 1) {return args[0]!;}
  }
  return type;
}

/** True when `node` is a `Promise<...>` type reference. */
function isPromiseTypeNode(node: ts.TypeNode): boolean {
  return (
    ts.isTypeReferenceNode(node) &&
    ts.isIdentifier(node.typeName) &&
    node.typeName.text === "Promise"
  );
}

/** True when a decorator callee is `signature` (bare or `ns.signature`). */
function isSignatureCallee(callee: ts.Expression): boolean {
  if (ts.isIdentifier(callee)) {return callee.text === "signature";}
  if (ts.isPropertyAccessExpression(callee)) {
    return callee.name.text === "signature";
  }
  return false;
}

/**
 * Arities of `forCtor(C).signature(...)` chains targeting `classDecl`, found by
 * scanning the source file. Each `.signature(...)` in a chain rooted at a
 * `forCtor(C)` whose argument resolves to `classDecl`'s symbol contributes one.
 */
function forCtorSignatureArities(
  classDecl: ts.ClassDeclaration,
  ctx: CheckContext,
): number[] {
  const target = classDecl.name && ctx.checker.getSymbolAtLocation(classDecl.name);
  if (!target) {return [];}

  const arities: number[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "signature"
    ) {
      const root = forCtorRoot(node.expression.expression);
      if (root) {
        const arg = root.arguments[0];
        const sym = arg && ctx.checker.getSymbolAtLocation(arg);
        const resolved =
          sym && sym.flags & ts.SymbolFlags.Alias
            ? ctx.checker.getAliasedSymbol(sym)
            : sym;
        if (resolved === target) {arities.push(node.arguments.length);}
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ctx.sourceFile);
  return arities;
}

/** Walk down a `.signature(...).signature(...)` chain to its `forCtor(C)` root. */
function forCtorRoot(expr: ts.Expression): ts.CallExpression | undefined {
  let cur: ts.Expression = expr;
  for (;;) {
    if (
      ts.isCallExpression(cur) &&
      ts.isIdentifier(cur.expression) &&
      cur.expression.text === "forCtor"
    ) {
      return cur;
    }
    if (
      ts.isCallExpression(cur) &&
      ts.isPropertyAccessExpression(cur.expression)
    ) {
      cur = cur.expression.expression;
      continue;
    }
    return undefined;
  }
}

/**
 * Scan a source file for tokens registered with an async `useFactory` (an
 * `async` arrow/function, or one whose annotated return type is `Promise<...>`)
 * via an `.add("token", { useFactory })` call. The token must be a string
 * literal first argument for the correlation to be static.
 *
 * This matches the explicit factory-registration form `add(token, spec)`, not
 * the type-driven `add<I>(C)` authoring form: only a two-argument call whose
 * second argument is an object literal carrying an async `useFactory` qualifies.
 */
export function collectAsyncTokens(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): Set<string> {
  const tokens = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "add" &&
      node.arguments.length >= 2
    ) {
      const tokenArg = node.arguments[0]!;
      const spec = node.arguments[1]!;
      if (
        ts.isStringLiteralLike(tokenArg) &&
        ts.isObjectLiteralExpression(spec) &&
        specIsAsyncFactory(spec, checker)
      ) {
        tokens.add(tokenArg.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return tokens;
}

/** True when an `.add` spec object's `useFactory` is async. */
function specIsAsyncFactory(
  spec: ts.ObjectLiteralExpression,
  checker: ts.TypeChecker,
): boolean {
  for (const prop of spec.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      prop.name.getText() === "useFactory"
    ) {
      return isAsyncFunctionExpression(prop.initializer, checker);
    }
    if (
      ts.isMethodDeclaration(prop) &&
      prop.name.getText() === "useFactory"
    ) {
      return hasAsyncModifier(prop) || returnsPromise(prop, checker);
    }
  }
  return false;
}

function isAsyncFunctionExpression(
  expr: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
    return hasAsyncModifier(expr) || returnsPromise(expr, checker);
  }
  return false;
}

function hasAsyncModifier(
  node: ts.FunctionLikeDeclarationBase,
): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some(
      (m) => m.kind === ts.SyntaxKind.AsyncKeyword,
    )
  );
}

/** True when a function-like node's signature return type is `Promise<...>`. */
function returnsPromise(
  node: ts.SignatureDeclaration,
  checker: ts.TypeChecker,
): boolean {
  const signature = checker.getSignatureFromDeclaration(node);
  if (!signature) {return false;}
  const ret = checker.getReturnTypeOfSignature(signature);
  return ret.getSymbol()?.getName() === "Promise";
}
