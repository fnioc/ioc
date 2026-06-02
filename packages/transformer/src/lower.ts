// Registration lowering + `defineDeps` emission (PRD §8).
//
// Three registration methods are lowered, all type-arg → string-token:
//   - `add<I>(C)`      [constructable] → `add("<token>", …)`        (class)
//   - `add<I>(fn)`     [callable]      → `addFactory("<token>", …)`  (factory)
//   - `addValue<I>(v)`                 → `addValue("<token>", v)`     (value)
// Plus every `.as<"x">()` → `.as("x")` in the chain.
//
// HOISTING (the safety invariant): whenever a registration emits a
// `defineDeps(...)` (a class or factory with a derivable signature), the arg is
// FIRST hoisted into a `const ɵregN = <arg>` and BOTH the `defineDeps(ɵregN, …)`
// and the `add`/`addFactory("token", ɵregN)` reference that one const. This
// guarantees the arg is evaluated exactly once and that metadata is keyed on the
// SAME object the registration uses — for ANY arg shape (inline lambda, named
// function/class reference, `fn.bind(x)`, `getCtor()`, …). We never try to
// decide which args are "safe to reference twice"; if we emit deps, we hoist.
//
// A dynamic arg with no statically derivable signature gets no dep array and no
// hoist (a single use) — the runtime throws with guidance if it needs metadata.
// An already-`@signature`/`forCtor`-annotated class is left to its own metadata
// (skip emission + info diagnostic).

import ts from "typescript";
import { deriveToken, type TokenContext } from "./tokens.js";
import {
  extractCtorReferenceSignature,
  extractFactoryReferenceSignature,
  extractFromExpression,
  extractSignatureFromFunction,
  hasSignatureDecorator,
  isAnyOfSlot,
  isFactorySlot,
  isScopeSlot,
  type ConstructorExtraction,
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
   * gets its OWN identifier node (a node may appear once in the tree). The
   * lowered form targets ESM output, where a bare `defineDeps(...)` call paired
   * with the injected named import is exactly correct. CJS output is NOT
   * supported: TypeScript's module transformer rewrites a named import to a
   * namespace property access (`core_1.defineDeps`) only for references it
   * resolved through the binder, and these synthesized calls were never bound,
   * so they would dangle. See transformer.ts (`injectDefineDepsImport`) for the
   * full caveat — until that is resolved, compile to ESM.
   */
  makeDefineDepsRef(): ts.Identifier;
  /** Set true whenever a registration is lowered (so we inject the import). */
  markUsedDefineDeps(): void;
  /**
   * A fresh, stable identifier NAME for a hoisted registration const (`ɵreg0`,
   * `ɵreg1`, …) — unique per source file. Callers mint a fresh identifier node
   * per use site (the const declaration and the registration reference), so no
   * node is shared across the tree.
   */
  nextHoistName(): string;
}

/** A method that the transformer lowers, keyed by its callee name. */
type RegMethod = "add" | "addValue";

/** A registration call found on the original (pre-rewrite) expression. */
interface FoundReg {
  readonly call: ts.CallExpression;
  readonly method: RegMethod;
  /**
   * The explicit `<I>` type argument, or `undefined` for a no-type-arg call
   * (`add(Something)`) where the token is derived from the value arg's own type.
   */
  readonly typeArg: ts.TypeNode | undefined;
  readonly arg: ts.Expression;
}

/** The rewrite plan for one registration call, computed against original nodes. */
interface RegPlan {
  /** The derived token (undefined when the type yields none → emit `null`). */
  readonly token: string | undefined;
  /** The runtime method to emit (`add` may be rewritten from an `add<I>(fn)`). */
  readonly calleeMethod: "add" | "addFactory" | "addValue";
  /**
   * When set, the registration's single value arg becomes this hoisted const's
   * identifier instead of the original expression.
   */
  readonly hoistName?: string;
}

/**
 * If `statement` is an expression statement containing one or more registration
 * chains, return the lowered statement plus any hoisted-const + `defineDeps(...)`
 * statements to insert before it. Returns `undefined` when the statement is not
 * a registration (the caller leaves it untouched).
 */
export function lowerStatement(
  statement: ts.Statement,
  ctx: LowerContext,
): ts.Statement[] | undefined {
  if (!ts.isExpressionStatement(statement)) return undefined;

  const registrations = findRegistrationCalls(statement.expression);
  if (registrations.length === 0) return undefined;

  const preludes: ts.Statement[] = [];
  const plans = new Map<ts.CallExpression, RegPlan>();

  for (const reg of registrations) {
    const token = tokenForReg(reg, ctx);
    if (reg.method === "addValue") {
      // Value: just a token prepend — no deps, no hoist (single use).
      plans.set(reg.call, { token, calleeMethod: "addValue" });
      continue;
    }
    plans.set(reg.call, planAddRegistration(reg.arg, token, ctx, preludes));
  }

  const loweredExpr = lowerRegistrationExpression(
    statement.expression,
    plans,
    ctx,
  );
  const loweredStatement = ctx.factory.updateExpressionStatement(
    statement,
    loweredExpr,
  );

  return [...preludes, loweredStatement];
}

/**
 * The registration method `call` invokes (`add` / `addValue`), or `undefined`.
 *
 * Requires exactly one value argument AND at most one type argument — the
 * type-driven authoring form. The `<I>` type arg is OPTIONAL: `add(Something)`
 * (no type arg) is valid authoring for a self-typed class, with the token
 * derived from the value arg's own type. The explicit forms (`add(token, ctor)`,
 * `addFactory(token, fn)`, `addValue(token, value)`) pass TWO value args and are
 * left untouched, so an explicit call is never misread as authoring.
 */
function registrationMethod(call: ts.CallExpression): RegMethod | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  if (call.typeArguments && call.typeArguments.length > 1) return undefined;
  if (call.arguments.length !== 1) return undefined;
  const name = callee.name.text;
  return name === "add" || name === "addValue" ? name : undefined;
}

/** True when `call` is a `*.as<"x">()` fluent scope tag. */
function isAsCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (callee.name.text !== "as") return false;
  if (!call.typeArguments || call.typeArguments.length !== 1) return false;
  return true;
}

/** True when `arg` is a factory function literal (arrow or function expr). */
function isFactoryArg(
  arg: ts.Expression,
): arg is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(arg) || ts.isFunctionExpression(arg);
}

/** Collect every `add<I>(…)` / `addValue<I>(…)` call reachable within `expr`. */
function findRegistrationCalls(expr: ts.Node): FoundReg[] {
  const found: FoundReg[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const method = registrationMethod(node);
      if (method) {
        found.push({
          call: node,
          method,
          typeArg: node.typeArguments?.[0],
          arg: node.arguments[0]!,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(expr);
  return found;
}

/**
 * Plan an `add` / `addFactory` registration: pick the runtime method
 * (constructable → `add`, callable → `addFactory`) and, when a dep signature is
 * statically derivable, hoist the arg + emit `defineDeps` against the const.
 */
function planAddRegistration(
  arg: ts.Expression,
  token: string | undefined,
  ctx: LowerContext,
  preludes: ts.Statement[],
): RegPlan {
  // Inline factory literal — signatures read straight off its parameters.
  if (isFactoryArg(arg)) {
    const signatures = extractSignatureFromFunction(arg, ctx);
    return emitHoisted(arg, token, signatures, "addFactory", ctx, preludes);
  }

  const type = ctx.checker.getTypeAtLocation(arg);

  // Constructable → a class. Prefer the full ClassDeclaration path (PRD §8
  // checks); fall back to the construct signature for a class with no static
  // declaration (a `getCtor()` result, a const-bound class expression).
  if (type.getConstructSignatures().length > 0) {
    const extraction = extractFromExpression(arg, ctx);
    const signatures = extraction
      ? classSignatureFromExtraction(extraction, arg, ctx)
      : extractCtorReferenceSignature(arg, ctx);
    return signatures
      ? emitHoisted(arg, token, signatures, "add", ctx, preludes)
      : { token, calleeMethod: "add" };
  }

  // Callable (not constructable) → a factory.
  if (type.getCallSignatures().length > 0) {
    const signatures = extractFactoryReferenceSignature(arg, ctx);
    return signatures
      ? emitHoisted(arg, token, signatures, "addFactory", ctx, preludes)
      : { token, calleeMethod: "addFactory" };
  }

  // Neither callable nor constructable (a dynamic / opaque value): assume a
  // class. No dep array — the runtime throws with guidance if it has params.
  return { token, calleeMethod: "add" };
}

/**
 * Hoist `arg` into a `const ɵregN = <arg>`, emit `defineDeps(ɵregN, signatures)`,
 * and return the plan that rewrites the registration to reference `ɵregN`.
 */
function emitHoisted(
  arg: ts.Expression,
  token: string | undefined,
  signatures: Signature[],
  calleeMethod: "add" | "addFactory",
  ctx: LowerContext,
  preludes: ts.Statement[],
): RegPlan {
  const hoistName = ctx.nextHoistName();
  preludes.push(hoistConstStatement(hoistName, arg, ctx.factory));
  ctx.markUsedDefineDeps();
  preludes.push(
    defineDepsStatement(
      ctx.factory.createIdentifier(hoistName),
      signatures,
      ctx.factory,
      ctx.makeDefineDepsRef(),
    ),
  );
  return { token, calleeMethod, hoistName };
}

/**
 * The class signature to emit for a statically-resolved class, running the PRD
 * §8 checks (equal-arity overload ambiguity, factory-param §4.5, async
 * mismatch). Returns `undefined` — skip `defineDeps` — when the class is already
 * manually annotated (`@signature` / `forCtor` is authoritative); an info
 * diagnostic is emitted so the skip is never silent.
 */
function classSignatureFromExtraction(
  extraction: ConstructorExtraction,
  concreteArg: ts.Expression,
  ctx: LowerContext,
): Signature[] | undefined {
  checkOverloads(extraction.classSymbol, concreteArg, ctx);

  const classDecl = extraction.classSymbol
    .getDeclarations()
    ?.find(ts.isClassDeclaration);
  const annotated =
    (classDecl && hasSignatureDecorator(classDecl)) ||
    ctx.forCtorAnnotated.has(extraction.classSymbol);
  if (annotated) {
    checkAnnotatedFactoryParams(extraction.classSymbol, ctx);
    ctx.sink.addDiagnostic(
      info(
        ctx.sourceFile,
        concreteArg,
        DiagnosticCode.AlreadyAnnotated,
        `${extraction.classSymbol.getName()} already has a manual @signature/forCtor annotation; ` +
          `skipping transformer-generated defineDeps (manual annotation is authoritative).`,
      ),
    );
    return undefined;
  }

  checkExtractedRegistration(extraction, ctx);
  return extraction.signatures;
}

/** Render `const <name> = <expr>;` — the hoisted registration const. */
function hoistConstStatement(
  name: string,
  expr: ts.Expression,
  factory: ts.NodeFactory,
): ts.Statement {
  return factory.createVariableStatement(
    undefined,
    factory.createVariableDeclarationList(
      [
        factory.createVariableDeclaration(
          factory.createIdentifier(name),
          undefined,
          undefined,
          expr,
        ),
      ],
      ts.NodeFlags.Const,
    ),
  );
}

/** Render `<defineDepsRef>(<targetExpr>, [[...sig], ...]);` as a statement. */
function defineDepsStatement(
  targetExpr: ts.Expression,
  signatures: Signature[],
  factory: ts.NodeFactory,
  defineDepsRef: ts.Identifier,
): ts.Statement {
  const signatureArrays = signatures.map((sig) =>
    factory.createArrayLiteralExpression(
      sig.map((slot) => slotLiteral(slot, factory)),
      false,
    ),
  );
  const signatureArray = factory.createArrayLiteralExpression(
    signatureArrays,
    false,
  );
  const call = factory.createCallExpression(defineDepsRef, undefined, [
    targetExpr,
    signatureArray,
  ]);
  return factory.createExpressionStatement(call);
}

/**
 * Render one signature slot as its emitted literal: `null` for a hole, a string
 * literal for a token, a `{ factory: "<token>" }` for a factory ref, a
 * `{ scope: true }` for a scope ref, and a `{ anyOf: [...] }` for an anyOf slot.
 */
function slotLiteral(slot: Slot, factory: ts.NodeFactory): ts.Expression {
  if (slot === null) return factory.createNull();
  if (isScopeSlot(slot)) {
    return factory.createObjectLiteralExpression(
      [factory.createPropertyAssignment("scope", factory.createTrue())],
      false,
    );
  }
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
  if (isAnyOfSlot(slot)) {
    // Emit: { anyOf: [<slot0>, <slot1>, ...] }
    const members = slot.anyOf.map((s) => slotLiteral(s, factory));
    return factory.createObjectLiteralExpression(
      [
        factory.createPropertyAssignment(
          "anyOf",
          factory.createArrayLiteralExpression(members, false),
        ),
      ],
      false,
    );
  }
  return factory.createStringLiteral(slot);
}

/**
 * Lower the registration expression: rewrite each planned `add`/`addValue` call
 * to its string-token form (routing factories to `addFactory` + the hoisted
 * const) and every `.as<"x">()` to `.as("x")`. Plans are keyed on ORIGINAL call
 * nodes — looked up before `visitEachChild` rebuilds them.
 */
function lowerRegistrationExpression(
  expr: ts.Expression,
  plans: ReadonlyMap<ts.CallExpression, RegPlan>,
  ctx: LowerContext,
): ts.Expression {
  const visit = (node: ts.Node): ts.Node => {
    if (ts.isCallExpression(node)) {
      const plan = plans.get(node);
      if (plan) {
        // A registration call: rewrite in place. Its sole value arg is kept
        // (value / dynamic) or replaced by the hoisted const — nothing inside to
        // recurse into.
        return lowerRegistrationCall(node, plan, ctx.factory);
      }
    }
    const visited = ts.visitEachChild(node, visit, undefined);
    if (ts.isCallExpression(visited) && isAsCall(visited)) {
      return lowerAsCall(visited, ctx.factory);
    }
    return visited;
  };
  return visit(expr) as ts.Expression;
}

/** Rewrite a single registration call per its plan (type arg dropped). */
function lowerRegistrationCall(
  call: ts.CallExpression,
  plan: RegPlan,
  factory: ts.NodeFactory,
): ts.CallExpression {
  const tokenLiteral =
    plan.token === undefined
      ? factory.createNull()
      : factory.createStringLiteral(plan.token);
  const callee = call.expression as ts.PropertyAccessExpression;
  const valueArg =
    plan.hoistName !== undefined
      ? factory.createIdentifier(plan.hoistName)
      : call.arguments[0]!;

  // Same callee name (class `add`, `addValue`) → update in place. A factory
  // authored as `add<I>(fn)` is renamed to `addFactory`.
  if (callee.name.text === plan.calleeMethod) {
    return factory.updateCallExpression(call, call.expression, undefined, [
      tokenLiteral,
      valueArg,
    ]);
  }
  return factory.createCallExpression(
    factory.createPropertyAccessExpression(callee.expression, plan.calleeMethod),
    undefined,
    [tokenLiteral, valueArg],
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

/**
 * The token for a registration — `T` resolved to a token, exactly as a written
 * `nameof<T>()` would. With an explicit `<I>` the type argument IS `T`. With
 * none (`add(Something)`), `T` is the type the matched overload INFERS: the
 * instance type for a class (`add<I>(Ctor<_, I>)`), the produced type for a
 * factory (`add<I>(() => I)`), or the value's own type for `addValue<I>(value)`.
 * Resolving the inferred `T` — not the raw arg type — makes the no-type-arg form
 * identical to the explicit one and round-trip with `resolve<Something>()`.
 */
function tokenForReg(reg: FoundReg, ctx: LowerContext): string | undefined {
  const type = reg.typeArg
    ? ctx.checker.getTypeFromTypeNode(reg.typeArg)
    : inferredRegType(reg, ctx);
  return deriveToken(type, ctx);
}

/** The type the matched overload binds to `T` for a no-type-arg registration. */
function inferredRegType(reg: FoundReg, ctx: LowerContext): ts.Type {
  const type = ctx.checker.getTypeAtLocation(reg.arg);
  if (reg.method === "addValue") return type;
  const ctorSigs = type.getConstructSignatures();
  if (ctorSigs.length > 0) return ctorSigs[0]!.getReturnType();
  const callSigs = type.getCallSignatures();
  if (callSigs.length > 0) return callSigs[0]!.getReturnType();
  return type;
}
