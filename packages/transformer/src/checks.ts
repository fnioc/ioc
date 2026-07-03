// Compile-time registration checks (PRD §4.5 / §8 "Factory-signature diagnostic").
//
// The transformer's primary value-add: clear, instructive feedback when a
// registration's static shape can't line up with what the container will do at
// resolve time. One conservative check — it fires ONLY where the mismatch is
// statically certain, never on a guess:
//
//   Factory-signature mismatch (§4.5). An inline-factory ctor param
//   `(b: B2, d: D4) => IFoo` must list, in order, the unregistered (hole)
//   params of IFoo's concrete constructor. When that concrete ctor is
//   statically reachable, compare arities and warn on a count mismatch (the
//   check is arity-only — it does not compare per-position types).

import ts from "typescript";
import {
  classDeclarationOfType,
  findConstructor,
  slotForParam,
  type ConstructorExtraction,
} from "./deps.js";
import {
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
}

/**
 * The factory-signature (§4.5) check for a class the transformer extracts a
 * signature from (i.e. NOT a manually-annotated class — those carry their own
 * author-supplied signatures). Best-effort: an un-resolvable shape is skipped,
 * never flagged.
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
  }
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
