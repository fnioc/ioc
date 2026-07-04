// Registration lowering + inline signature emission (PRD §8).
//
// Three registration methods are lowered, all type-arg → string-token:
//   - `add<I>(C)`      [constructable] → `add("<token>", C, [[...]])`         (class)
//   - `add<I>(fn)`     [callable]      → `addFactory("<token>", fn, [[...]])`  (factory)
//   - `addValue<I>(v)`                 → `addValue("<token>", v)`              (value)
// Plus every `.as<"x">()` → `.as("x")` in the chain.
//
// SIGNATURES RIDE ON THE REGISTRATION: whenever a class/factory registration has
// a statically derivable signature, it is emitted INLINE as the registration
// call's THIRD argument (`add(token, ctor, [[...sig...]])`). The global metadata
// store is retired — there is no separate `defineDeps(...)` prelude and no hoist:
// the signature travels with the registration, keyed on the registration record
// rather than the ctor object, so one JS class closes differently per registration.
//
// A dynamic arg with no statically derivable signature gets no signature array —
// the runtime throws with guidance if it needs metadata (a nonzero-arg ctor).

import ts from "typescript";
import { isOpenToken, parseToken } from "./grammar.js";
import { deriveToken, type LiteralValue, type TokenContext } from "./tokens.js";
import {
  extractCtorReferenceSignature,
  extractFactoryReferenceSignature,
  extractFromExpression,
  extractInstantiatedSignature,
  extractSignatureFromFunction,
  isFactorySlot,
  isLiteralSlot,
  isScopeSlot,
  isTypeArgSlot,
  isUnionSlot,
  type ConstructorExtraction,
  type DepContext,
  type Signature,
  type Slot,
} from "./deps.js";
import {
  checkExtractedRegistration,
  type CheckContext,
} from "./checks.js";
import {
  DiagnosticCode,
  error,
  warning,
  type DiagnosticSink,
} from "./diagnostics.js";

export interface LowerContext extends CheckContext, DepContext {
  readonly factory: ts.NodeFactory;
  readonly sink: DiagnosticSink;
  readonly sourceFile: ts.SourceFile;
}

/** A method that the transformer lowers, keyed by its callee name. */
type RegMethod = "add" | "addValue";

/**
 * What `registrationMethod` matched: the canonical lowered method (`add` /
 * `addValue`) plus, for a per-scope authoring form (`addRequest(C)`), the scope
 * tag baked into the method name. A plain `add<I>(...)` carries no scope.
 */
interface MatchedMethod {
  readonly method: RegMethod;
  /**
   * The scope tag recovered from a per-scope `add${ProperCase<K>}` method name
   * (`addRequest` → `"request"`), or `undefined` for a plain `add`/`addValue`.
   * When set, the lowered call gains a trailing `.as(scope)`.
   */
  readonly scope?: string;
}

/** A registration call found on the original (pre-rewrite) expression. */
interface FoundReg {
  readonly call: ts.CallExpression;
  readonly method: RegMethod;
  /**
   * The scope tag from a per-scope authoring method (`addRequest`), appended as
   * `.as(scope)` on the lowered call. `undefined` for a plain `add`/`addValue`.
   */
  readonly scope?: string;
  /**
   * The explicit `<I>` type argument, or `undefined` for a no-type-arg call
   * (`add(Something)`) where the token is derived from the value arg's own type.
   */
  readonly typeArg: ts.TypeNode | undefined;
  readonly arg: ts.Expression;
  /**
   * The positional override array expression (the second value argument), if
   * present. Only meaningful for `add` registrations where the second arg is the
   * registration-time override array (`add<I>(C, ["tok1", undefined, "tok2"])`).
   */
  readonly overrideArg?: ts.Expression;
}

/** The rewrite plan for one registration call, computed against original nodes. */
interface RegPlan {
  /** The derived token (undefined when the type yields none → emit `null`). */
  readonly token: string | undefined;
  /** The runtime method to emit (`add` may be rewritten from an `add<I>(fn)`). */
  readonly calleeMethod: "add" | "addFactory" | "addValue";
  /**
   * A per-scope authoring tag (`addRequest` → `"request"`). When set, the lowered
   * call is wrapped in `.as(scope)` — the scope was baked into the source method
   * name rather than written as a fluent `.as<"request">()` continuation.
   */
  readonly scope?: string;
  /**
   * When set, the registration's value arg becomes this expression — the plain
   * ctor of an instantiation expression (`SqlRepository<$<1>>` → `SqlRepository`,
   * type args stripped). Otherwise the original value arg is kept verbatim.
   */
  readonly valueOverride?: ts.Expression;
  /**
   * Registration-carried dep signatures — emitted as the THIRD argument of the
   * lowered `add(token, ctor, signatures)` / `addFactory(token, fn, signatures)`
   * call. The sole signature channel now that the global store is retired.
   */
  readonly signatures?: Signature[];
}

/**
 * If `statement` is an expression statement containing one or more registration
 * chains, return the lowered statement. Signatures ride inline on each lowered
 * registration call (no separate prelude). Returns `undefined` when the statement
 * is not a registration (the caller leaves it untouched).
 */
export function lowerStatement(
  statement: ts.Statement,
  ctx: LowerContext,
): ts.Statement[] | undefined {
  if (!ts.isExpressionStatement(statement)) {return undefined;}

  const registrations = findRegistrationCalls(statement.expression);
  if (!registrations.length) {return undefined;}

  const plans = new Map<ts.CallExpression, RegPlan>();

  for (const reg of registrations) {
    const token = tokenForReg(reg, ctx);
    if (reg.method === "addValue") {
      // Value: just a token prepend — no deps, no hoist (single use). An open
      // template token is a hard error — a value has no per-closing construction.
      if (token !== undefined && isOpenToken(token)) {
        emitOpenTokenError(token, "addValue", reg, ctx);
      }
      plans.set(reg.call, { token, calleeMethod: "addValue" });
      continue;
    }
    // v1 open-service restriction: every type arg of an open service token must
    // be a bare hole (`IFoo<$<1>,$<2>>` — repeats allowed); concrete/hole mixes and
    // nested holes (`IFoo<$<1>,string>`, `IFoo<IBar<$<1>>>`) are a hard error.
    const shape = classifyServiceToken(token);
    if (shape.mixed) {
      ctx.sink.addDiagnostic(
        error(
          ctx.sourceFile,
          reg.typeArg ?? reg.call,
          DiagnosticCode.MixedServiceTokenArgs,
          `open service token "${token}" mixes holes and concrete type args — ` +
            "every type arg of an open service token must be a hole " +
            "(`IFoo<$<1>,$<2>>`); close the token fully or open it fully",
        ),
      );
    }
    const plan = planAddRegistration(reg, token, shape, ctx);
    // A per-scope authoring method (`addRequest(C)`) bakes its scope into the
    // method name; carry it so the lowered call gains a trailing `.as(scope)`.
    plans.set(reg.call, reg.scope === undefined ? plan : { ...plan, scope: reg.scope });
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

  return [loweredStatement];
}

/**
 * The registration method `call` invokes (`add` / `addValue`), or `undefined`.
 *
 * Accepts one OR two value arguments for `add` (the second is the optional
 * registration-time override array). `addValue` accepts only one value arg.
 * The `<I>` type arg is OPTIONAL: `add(Something)` (no type arg) is valid
 * authoring. The already-lowered explicit forms (`add(token, ctor)`,
 * `addFactory(token, fn)`, `addValue(token, value)`) pass a STRING as the first
 * arg and are left untouched (the first arg of a lowered call is always a string
 * literal token, not a ctor reference).
 *
 * Disambiguation for two-arg `add`:
 *   - `add<I>(C, overrides)` — type-arg form with override array → type-driven
 *   - `add(token, C)` — already-lowered explicit form → NOT type-driven
 *
 * We detect the already-lowered form by checking: if the call has NO type arg
 * and the first arg is a string literal, leave it untouched.
 */
function registrationMethod(call: ts.CallExpression): MatchedMethod | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) {return undefined;}
  if (call.typeArguments && call.typeArguments.length > 1) {return undefined;}
  const name = callee.name.text;

  // Per-scope authoring method: `add${ProperCase<K>}` (`addRequest`, `addSession`)
  // — NOT `add` / `addFactory` / `addValue`. Scope tags are guarded lowercase-first
  // (`ValidScopes`), so the scope is the EXACT uncapitalize-first of the suffix.
  // Only the SINGLE-arg authored form lowers (`addRequest(C)` / `addRequest(fn)`);
  // the two-arg runtime form (`addRequest("token", C)`) is already lowered and
  // passes through untouched.
  if (
    SCOPE_ADD_METHOD.test(name) &&
    name !== "addFactory" &&
    name !== "addValue"
  ) {
    if (call.arguments.length !== 1) {return undefined;}
    const scope = name[3]!.toLowerCase() + name.slice(4);
    return { method: "add", scope };
  }

  if (name !== "add" && name !== "addValue") {return undefined;}
  // addValue only accepts exactly one value arg.
  if (name === "addValue") {
    return call.arguments.length === 1 ? { method: "addValue" } : undefined;
  }
  // add: accept 1 arg (standard form) or 2 args (override-array form).
  if (call.arguments.length === 1) {return { method: "add" };}
  if (call.arguments.length === 2) {
    // Two-arg form is only type-driven when there IS a type argument.
    // Without a type arg + two value args → already-lowered explicit form,
    // or the string-first explicit form → leave untouched.
    if (!call.typeArguments || !call.typeArguments.length) {return undefined;}
    return { method: "add" };
  }
  return undefined;
}

/**
 * The per-scope authoring method pattern: `add` followed by an uppercase letter
 * (`addRequest`, `addSession`). `addFactory` / `addValue` also match this regex,
 * so callers exclude them explicitly — they are the existing runtime methods, not
 * scope-minted ones.
 */
const SCOPE_ADD_METHOD = /^add[A-Z]/;

/** True when `call` is a `*.as<"x">()` fluent scope tag. */
function isAsCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) {return false;}
  if (callee.name.text !== "as") {return false;}
  if (!call.typeArguments || call.typeArguments.length !== 1) {return false;}
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
      const matched = registrationMethod(node);
      if (matched) {
        found.push({
          call: node,
          method: matched.method,
          scope: matched.scope,
          typeArg: node.typeArguments?.[0],
          arg: node.arguments[0]!,
          overrideArg: node.arguments.length >= 2 ? node.arguments[1] : undefined,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(expr);
  return found;
}

/**
 * Merge a registration-time override array over a base signature (design §6).
 * A non-`undefined` DepSlot-like element at position i overrides the derived
 * token; `undefined` (or array holes) keeps the derived slot. Returns the merged
 * signature with overrides applied.
 *
 * The override array is a literal `ts.ArrayLiteralExpression`. We read it
 * positionally: an `OmittedExpression` (elision/hole) or `undefined` identifier
 * means "keep derived"; a string literal is the override token. Any other
 * element (object literal, variable, call) cannot be statically resolved — the
 * derived token is kept and an `UnresolvableOverrideElement` diagnostic fires.
 */
function applyOverrides(
  baseSignature: Signature,
  overrideNode: ts.Expression,
  ctx: LowerContext,
): Signature | undefined {
  if (!ts.isArrayLiteralExpression(overrideNode)) {return undefined;}
  const overrides = overrideNode.elements;
  const result: Slot[] = baseSignature.slice();
  for (let i = 0; i < overrides.length; i++) {
    const elem = overrides[i]!;
    // OmittedExpression (elision) or `undefined` literal → keep derived.
    if (ts.isOmittedExpression(elem)) {continue;}
    if (ts.isIdentifier(elem) && elem.text === "undefined") {continue;}
    // A string literal is the documented common case: a token override.
    if (ts.isStringLiteralLike(elem)) {
      result[i] = elem.text;
      continue;
    }
    // Anything else (object literal, variable, call) can't be statically
    // resolved. Rather than silently keep the derived slot, flag it so the
    // author knows the override didn't take.
    ctx.sink.addDiagnostic(
      warning(
        ctx.sourceFile,
        elem,
        DiagnosticCode.UnresolvableOverrideElement,
        `override element at position ${i} is not a string-literal token; the ` +
          "transformer cannot resolve it statically, so the derived token is " +
          "kept. Use a string-literal token (or `undefined` to keep the derived " +
          "token).",
      ),
    );
  }
  return result;
}

/**
 * The static shape of a registration's SERVICE token w.r.t. the open-generics
 * grammar: which holes its template binds, and whether it violates the v1
 * all-holes-or-all-concrete restriction.
 */
interface ServiceTokenShape {
  /** Hole numbers bound by the template's top-level args (empty when closed). */
  readonly holes: ReadonlySet<number>;
  /** Open, but not every top-level arg is a bare hole — 990008 territory. */
  readonly mixed: boolean;
}

/** Classify a derived service token against the open-template grammar. */
function classifyServiceToken(token: string | undefined): ServiceTokenShape {
  const holes = new Set<number>();
  const parsed = token === undefined ? undefined : parseToken(token);
  if (!parsed) {return { holes, mixed: false };}
  let sawConcrete = false;
  let sawHole = false;
  for (const arg of parsed.args) {
    const hole = HOLE_NODE.exec(arg);
    if (hole) {
      holes.add(Number(hole[1]));
      sawHole = true;
    } else {
      sawConcrete = true;
      // A nested hole (`IFoo<IBar<$<1>>>`) opens the token without being a
      // top-level hole — that counts as mixed too.
      if (isOpenToken(arg)) {sawHole = true;}
    }
  }
  return { holes, mixed: sawHole && sawConcrete };
}

/** A token node that is exactly a hole: `$N`, decimal N ≥ 1 (capture: N). */
const HOLE_NODE = /^\$([1-9][0-9]*)$/;

/** Hole numbers at any depth of a token (grammar-aware, recursive). */
function* tokenHoles(token: string): Generator<number> {
  const hole = HOLE_NODE.exec(token);
  if (hole) {
    yield Number(hole[1]);
    return;
  }
  const parsed = parseToken(token);
  if (!parsed) {return;}
  for (const arg of parsed.args) {yield* tokenHoles(arg);}
}

/** Hole numbers referenced anywhere in a dep slot (recursive over unions). */
function* slotHoles(slot: Slot): Generator<number> {
  if (typeof slot === "string") {
    yield* tokenHoles(slot);
    return;
  }
  if (isTypeArgSlot(slot)) {
    yield slot.typeArg;
    return;
  }
  if (isFactorySlot(slot)) {
    yield* tokenHoles(slot.type);
    for (const p of slot.params ?? []) {yield* tokenHoles(p);}
    return;
  }
  if (isUnionSlot(slot)) {
    for (const member of slot.union) {yield* slotHoles(member);}
  }
  // Scope / literal slots carry no holes.
}

/**
 * Every hole a dep signature references must be bound by the service template
 * (990010) — substitution at close time has no argument for an unbound one.
 * Skipped for a mixed service token (990008 already fired; the hole set is not
 * meaningful).
 */
function checkDepHoles(
  signatures: readonly Signature[],
  token: string | undefined,
  shape: ServiceTokenShape,
  anchor: ts.Node,
  ctx: LowerContext,
): void {
  if (shape.mixed) {return;}
  const orphans = new Set<number>();
  for (const sig of signatures) {
    for (const slot of sig) {
      for (const n of slotHoles(slot)) {
        if (!shape.holes.has(n)) {orphans.add(n);}
      }
    }
  }
  if (!orphans.size) {return;}
  const list = [...orphans]
    .sort((a, b) => a - b)
    .map((n) => `$${n}`)
    .join(", ");
  ctx.sink.addDiagnostic(
    error(
      ctx.sourceFile,
      anchor,
      DiagnosticCode.DepHoleNotInServiceTemplate,
      `dependency hole(s) ${list} are not bound by the service token ` +
        `"${token}" — every hole a dependency references must appear in the ` +
        "service token's type arguments",
    ),
  );
}

/** Emit the 990009 error: an open template token on a value/factory registration. */
function emitOpenTokenError(
  token: string,
  method: "addValue" | "addFactory",
  reg: FoundReg,
  ctx: LowerContext,
): void {
  ctx.sink.addDiagnostic(
    error(
      ctx.sourceFile,
      reg.typeArg ?? reg.call,
      DiagnosticCode.OpenTokenOnValueOrFactory,
      `open template token "${token}" on ${method} — open registrations are ` +
        "class registrations only; register a class implementation or close " +
        "the token",
    ),
  );
}

/**
 * Plan an `add` / `addFactory` registration: pick the runtime method
 * (constructable → `add`, callable → `addFactory`) and, when a dep signature is
 * statically derivable, carry it ON THE REGISTRATION as the inline third
 * argument (`add(token, ctor, [[...]])` / `addFactory(token, fn, [[...]])`).
 *
 * A GENERIC impl — an instantiation expression (`SqlRepository<$<1>>`,
 * `Foo<string>`) — passes the plain ctor with type args stripped (via
 * `valueOverride`); every other class/factory keeps its original value arg.
 */
function planAddRegistration(
  reg: FoundReg,
  token: string | undefined,
  shape: ServiceTokenShape,
  ctx: LowerContext,
): RegPlan {
  const arg = reg.arg;
  const overrideArg = reg.overrideArg;
  const openToken = token !== undefined && isOpenToken(token);

  // Inline factory literal — signatures read straight off its parameters.
  if (isFactoryArg(arg)) {
    if (openToken) {emitOpenTokenError(token, "addFactory", reg, ctx);}
    const signatures = extractSignatureFromFunction(arg, ctx);
    checkDepHoles(signatures, token, shape, arg, ctx);
    return { token, calleeMethod: "addFactory", signatures };
  }

  // Instantiation expression (TS 4.7+): a generic impl, open or closed. The
  // construct signatures on the EWTA's type are already instantiated, so the
  // extracted slots surface holes as `$N` / `{ typeArg: N }` (or the concrete
  // tokens of a closed registration) directly.
  if (ts.isExpressionWithTypeArguments(arg)) {
    const signatures = extractInstantiatedSignature(arg, ctx);
    if (signatures) {
      checkDepHoles(signatures, token, shape, arg, ctx);
      return {
        token,
        calleeMethod: "add",
        valueOverride: arg.expression,
        signatures,
      };
    }
    // Not constructable (e.g. a generic function instantiation) — fall through
    // to the type-driven routing below, exactly as before.
  }

  const type = ctx.checker.getTypeAtLocation(arg);

  // Constructable → a class. Prefer the full ClassDeclaration path (PRD §8
  // checks); fall back to the construct signature for a class with no static
  // declaration (a `getCtor()` result, a const-bound class expression).
  if (type.getConstructSignatures().length) {
    const extraction = extractFromExpression(arg, ctx);
    let signatures = extraction
      ? classSignatureFromExtraction(extraction, ctx)
      : extractCtorReferenceSignature(arg, ctx);
    // Apply the registration-time override array (design §6) if present.
    if (signatures && overrideArg) {
      signatures = signatures.map((sig) => {
        const merged = applyOverrides(sig, overrideArg, ctx);
        return merged ?? sig;
      });
    }
    if (signatures) {
      checkDepHoles(signatures, token, shape, arg, ctx);
    }
    return { token, calleeMethod: "add", signatures: signatures ?? undefined };
  }

  // Callable (not constructable) → a factory.
  if (type.getCallSignatures().length) {
    if (openToken) {emitOpenTokenError(token, "addFactory", reg, ctx);}
    const signatures = extractFactoryReferenceSignature(arg, ctx);
    if (signatures) {
      checkDepHoles(signatures, token, shape, arg, ctx);
    }
    return { token, calleeMethod: "addFactory", signatures: signatures ?? undefined };
  }

  // Neither callable nor constructable (a dynamic / opaque value): assume a
  // class. No signature array — the runtime throws with guidance if it has params.
  return { token, calleeMethod: "add" };
}

/**
 * The class signature to emit for a statically-resolved class, running the PRD
 * §8 factory-param (§4.5) check. Always returns the extracted signatures — the
 * transformer is the sole signature channel.
 */
function classSignatureFromExtraction(
  extraction: ConstructorExtraction,
  ctx: LowerContext,
): Signature[] {
  checkExtractedRegistration(extraction, ctx);
  return extraction.signatures;
}

/** Render `[[...sig], ...]` — a signatures array literal (the `add`/`addFactory` 3rd arg). */
function signaturesLiteral(
  signatures: Signature[],
  factory: ts.NodeFactory,
): ts.Expression {
  const signatureArrays = signatures.map((sig) =>
    factory.createArrayLiteralExpression(
      sig.map((slot) => slotLiteral(slot, factory)),
      false,
    ),
  );
  return factory.createArrayLiteralExpression(signatureArrays, false);
}

/**
 * Render one signature slot as its emitted literal:
 *   - a string literal for a token
 *   - `{ type: "<token>" }` (or `{ type: "<token>", params: [...] }`) for a factory ref
 *   - `{ scope: true }` for a scope ref
 *   - `{ union: [slot, slot, ...] }` for a union slot (recursive)
 *   - `{ value: <literal> }` for a literal slot (Rule 2)
 *   - `{ typeArg: N }` for a type-arg ref (an open `Typeof<Hole<N>>` param)
 *
 * There is no `null` emission — the `null`/hole sentinel has been removed.
 */
function slotLiteral(slot: Slot, factory: ts.NodeFactory): ts.Expression {
  if (isTypeArgSlot(slot)) {
    return factory.createObjectLiteralExpression(
      [
        factory.createPropertyAssignment(
          "typeArg",
          factory.createNumericLiteral(slot.typeArg),
        ),
      ],
      false,
    );
  }
  if (isScopeSlot(slot)) {
    return factory.createObjectLiteralExpression(
      [factory.createPropertyAssignment("scope", factory.createTrue())],
      false,
    );
  }
  if (isUnionSlot(slot)) {
    const memberExprs = slot.union.map((m) => slotLiteral(m, factory));
    return factory.createObjectLiteralExpression(
      [
        factory.createPropertyAssignment(
          "union",
          factory.createArrayLiteralExpression(memberExprs, false),
        ),
      ],
      false,
    );
  }
  if (isLiteralSlot(slot)) {
    return factory.createObjectLiteralExpression(
      [factory.createPropertyAssignment("value", literalExpression(slot.value, factory))],
      false,
    );
  }
  if (isFactorySlot(slot)) {
    const props: ts.ObjectLiteralElementLike[] = [
      factory.createPropertyAssignment(
        "type",
        factory.createStringLiteral(slot.type),
      ),
    ];
    if (slot.params && slot.params.length) {
      props.push(
        factory.createPropertyAssignment(
          "params",
          factory.createArrayLiteralExpression(
            slot.params.map((p) => factory.createStringLiteral(p)),
            false,
          ),
        ),
      );
    }
    return factory.createObjectLiteralExpression(props, false);
  }
  return factory.createStringLiteral(slot);
}

/**
 * Render a `LiteralRef` value as its TS literal expression. `undefined` emits
 * `void 0` (a non-shadowable undefined); `null` emits `null`. A negative number
 * is a unary minus over its magnitude; a bigint emits a `BigIntLiteral`
 * (`createBigIntLiteral` takes the digit string WITH the trailing `n`, magnitude
 * only, so a negative bigint is a unary minus over the positive literal).
 */
export function literalExpression(
  value: LiteralValue,
  factory: ts.NodeFactory,
): ts.Expression {
  if (value === undefined) {
    return factory.createVoidExpression(factory.createNumericLiteral(0));
  }
  if (value === null) {return factory.createNull();}
  if (typeof value === "string") {return factory.createStringLiteral(value);}
  if (typeof value === "boolean") {
    return value ? factory.createTrue() : factory.createFalse();
  }
  if (typeof value === "bigint") {
    const negative = value < 0n;
    const literal = factory.createBigIntLiteral(`${negative ? -value : value}n`);
    return negative
      ? factory.createPrefixUnaryExpression(ts.SyntaxKind.MinusToken, literal)
      : literal;
  }
  const negative = value < 0 || Object.is(value, -0);
  const literal = factory.createNumericLiteral(Math.abs(value));
  return negative
    ? factory.createPrefixUnaryExpression(ts.SyntaxKind.MinusToken, literal)
    : literal;
}

/**
 * Lower the registration expression: rewrite each planned `add`/`addValue` call
 * to its string-token form (routing factories to `addFactory`) and every
 * `.as<"x">()` to `.as("x")`. Plans are keyed on ORIGINAL call nodes — looked
 * up before `visitEachChild` rebuilds them.
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
        // (value / dynamic) or replaced by the plain, un-parameterized ctor for
        // a generic impl (`valueOverride`) — nothing inside to recurse into.
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
  const valueArg = plan.valueOverride ?? call.arguments[0]!;

  // The runtime call: `(token, value)` — plus registration-carried signatures as
  // a third argument (the sole signature channel; the global store is retired).
  const args: ts.Expression[] = [tokenLiteral, valueArg];
  if (plan.signatures) {
    args.push(signaturesLiteral(plan.signatures, factory));
  }

  // Same callee name (class `add`, `addValue`) → update in place; a factory
  // authored as `add<I>(fn)` or any per-scope method is built fresh on
  // `plan.calleeMethod` (`add` / `addFactory`).
  const runtimeCall =
    callee.name.text === plan.calleeMethod
      ? factory.updateCallExpression(call, call.expression, undefined, args)
      : factory.createCallExpression(
          factory.createPropertyAccessExpression(
            callee.expression,
            plan.calleeMethod,
          ),
          undefined,
          args,
        );

  // A per-scope authoring form (`addRequest(C)`) bakes the scope into the name —
  // append `.as(scope)`, mirroring the lowered fluent `add<I>(C).as("request")`.
  if (plan.scope === undefined) {
    return runtimeCall;
  }
  return factory.createCallExpression(
    factory.createPropertyAccessExpression(runtimeCall, "as"),
    undefined,
    [factory.createStringLiteral(plan.scope)],
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
  if (reg.method === "addValue") {return type;}
  const ctorSigs = type.getConstructSignatures();
  if (ctorSigs.length) {return ctorSigs[0]!.getReturnType();}
  const callSigs = type.getCallSignatures();
  if (callSigs.length) {return callSigs[0]!.getReturnType();}
  return type;
}
