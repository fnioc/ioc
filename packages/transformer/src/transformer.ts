// The transformer harness (PRD §8 "Tooling").
//
// Two layers:
//   - `default` export: the ts-patch PROGRAM transformer entry. ts-patch calls
//     it with `(program, config, extras)`; `extras.addDiagnostic` is the
//     diagnostic stream and `program.getTypeChecker()` is the type source.
//   - `createTransformerFactory(program, sink)`: the underlying
//     `ts.TransformerFactory<ts.SourceFile>` the tests drive directly against an
//     in-memory Program (no ts-patch needed to exercise the rewrite).
//
// Per SourceFile the visitor:
//   1. Collects `forCtor(C)` annotations (so registrations of C skip emission).
//   2. Lowers each registration statement (`add<I>(C).as<"x">()` → string form)
//      and inserts the `defineDeps(...)` prelude.
//   3. Rewrites every `nameof<T>()` call to its string token.
//   4. Injects an `import { defineDeps } from "@fnioc/di"` when a registration
//      was lowered and the file does not already import it.

import ts from "typescript";
import type { Func } from "@rhombus-toolkit/func";
import { lowerStatement, type LowerContext } from "./lower.js";
import {
  deriveToken,
  tokenForReturnType,
  type TokenContext,
} from "./tokens.js";
import { collectAsyncTokens } from "./checks.js";
import type { DiagnosticSink } from "./diagnostics.js";
import { NAMEOF_NAME } from "./nameof.js";

/** The runtime package whose `defineDeps` the lowered output calls. */
const RUNTIME_MODULE = "@fnioc/di";
const DEFINE_DEPS = "defineDeps";

/**
 * Create the `ts.TransformerFactory` that rewrites a SourceFile. Exposed so the
 * test harness can run the transformer against an in-memory Program without
 * ts-patch.
 */
export function createTransformerFactory(
  program: ts.Program,
  sink: DiagnosticSink,
  options: { readFile?: Func<[string], string | undefined> } = {},
): ts.TransformerFactory<ts.SourceFile> {
  const checker = program.getTypeChecker();
  const projectRoot = computeProjectRoot(program);

  return (context) => (sourceFile) =>
    transformSourceFile(sourceFile, {
      checker,
      projectRoot,
      readFile: options.readFile,
      factory: context.factory,
      sink,
    });
}

interface FileContext extends TokenContext {
  readonly factory: ts.NodeFactory;
  readonly sink: DiagnosticSink;
}

function transformSourceFile(
  sourceFile: ts.SourceFile,
  ctx: FileContext,
): ts.SourceFile {
  const forCtorAnnotated = collectForCtorAnnotations(sourceFile, ctx.checker);
  const asyncTokens = collectAsyncTokens(sourceFile, ctx.checker);

  // The local name every emitted `defineDeps(...)` call uses, and whether we
  // need to inject the import. When the file already imports `defineDeps`, we
  // reference its existing local name (honoring an alias); otherwise we inject
  // `import { defineDeps }` and reference the plain name. The lowered form
  // targets ESM output — see injectDefineDepsImport for the CJS caveat.
  const existing = existingDefineDepsBinding(sourceFile);
  const localName = existing?.text ?? DEFINE_DEPS;
  const makeDefineDepsRef = (): ts.Identifier =>
    ctx.factory.createIdentifier(localName);

  let usedDefineDeps = false;
  let hoistCounter = 0;
  const lowerCtx: LowerContext = {
    ...ctx,
    sourceFile,
    forCtorAnnotated,
    asyncTokens,
    makeDefineDepsRef,
    markUsedDefineDeps() {
      usedDefineDeps = true;
    },
    nextHoistName() {
      return `ɵreg${hoistCounter++}`;
    },
  };

  // 1 + 2: lower registration statements (and emit defineDeps preludes), and
  //        within every remaining node, rewrite nameof<T>() calls.
  const statements = lowerStatements(sourceFile.statements, lowerCtx);

  let updated = ts.factory.updateSourceFile(sourceFile, statements);

  // 3: inject the defineDeps import when a registration lowered and the file
  //    did not already import it.
  if (usedDefineDeps && !existing) {
    updated = injectDefineDepsImport(updated, ctx.factory);
  }

  return updated;
}

/**
 * Lower each top-level statement: registration statements expand to
 * `[defineDeps..., loweredStmt]`; all statements then get a nameof rewrite pass.
 */
function lowerStatements(
  statements: ts.NodeArray<ts.Statement>,
  ctx: LowerContext,
): ts.Statement[] {
  const out: ts.Statement[] = [];
  for (const statement of statements) {
    const lowered = lowerStatement(statement, ctx);
    const each = lowered ?? [statement];
    for (const s of each) {
      out.push(rewriteResolve(rewriteNameof(s, ctx), ctx) as ts.Statement);
    }
  }
  return out;
}

/**
 * Rewrite every tokenless `*.resolve<I>()` call (one type argument, NO value
 * argument) within `node` to its string-token form, anywhere in the tree —
 * resolution calls are not confined to top-level statements. A function-typed
 * type arg (`resolve<(a: A) => T>()`) is a FACTORY request: it lowers to
 * `*.resolveFactory("<token-for-return-type>")`; any other type arg lowers to
 * `*.resolve("<token-for-I>")`. The explicit `resolve<T>(token)` form carries a
 * value argument and is left untouched.
 */
function rewriteResolve(node: ts.Node, ctx: LowerContext): ts.Node {
  const visit = (n: ts.Node): ts.Node => {
    const visited = ts.visitEachChild(n, visit, undefined);
    if (ts.isCallExpression(visited) && isTokenlessResolveCall(visited)) {
      return lowerResolveCall(visited, ctx);
    }
    return visited;
  };
  return visit(node);
}

/** True when `call` is a tokenless `*.resolve<I>()` (1 type arg, 0 value args). */
function isTokenlessResolveCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (callee.name.text !== "resolve") return false;
  if (!call.typeArguments || call.typeArguments.length !== 1) return false;
  return call.arguments.length === 0;
}

/** `*.resolve<I>()` → `*.resolve("tok")` / `*.resolveFactory("tok:return")`. */
function lowerResolveCall(
  call: ts.CallExpression,
  ctx: LowerContext,
): ts.CallExpression {
  const callee = call.expression as ts.PropertyAccessExpression;
  const typeArg = call.typeArguments![0]!;

  let method = "resolve";
  let token: string | undefined;
  if (ts.isFunctionTypeNode(typeArg)) {
    method = "resolveFactory";
    const signature = ctx.checker.getSignatureFromDeclaration(typeArg);
    token = signature ? tokenForReturnType(signature, ctx) : undefined;
  } else {
    token = deriveToken(ctx.checker.getTypeFromTypeNode(typeArg), ctx);
  }

  const newCallee =
    method === callee.name.text
      ? callee
      : ctx.factory.createPropertyAccessExpression(callee.expression, method);
  const tokenLiteral =
    token === undefined
      ? ctx.factory.createNull()
      : ctx.factory.createStringLiteral(token);
  return ctx.factory.updateCallExpression(call, newCallee, undefined, [
    tokenLiteral,
  ]);
}

/** Rewrite every `nameof<T>()` call within `node` to its string token. */
function rewriteNameof(node: ts.Node, ctx: LowerContext): ts.Node {
  const visit = (n: ts.Node): ts.Node => {
    if (ts.isCallExpression(n) && isNameofCall(n, ctx.checker)) {
      const typeArg = n.typeArguments![0]!;
      const type = ctx.checker.getTypeFromTypeNode(typeArg);
      const token = deriveToken(type, ctx);
      return token === undefined
        ? ctx.factory.createStringLiteral("")
        : ctx.factory.createStringLiteral(token);
    }
    return ts.visitEachChild(n, visit, undefined);
  };
  return visit(node);
}

/**
 * True when `call` is a single-type-argument call to `nameof`.
 *
 * Matches when EITHER the local callee name is `nameof` (the direct
 * `nameof<T>()` form, and the common case where the import is unresolved in a
 * lightweight Program) OR the resolved symbol's real name is `nameof` (so an
 * aliased import `import { nameof as keyOf }` still matches). The syntactic
 * `nameof<T>()` form is the documented authoring surface, so matching on the
 * name is intentional — a user-defined function of the same name is expected to
 * be the transformer's `nameof`.
 */
function isNameofCall(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
  if (!call.typeArguments || call.typeArguments.length !== 1) return false;
  const callee = call.expression;
  const id = ts.isIdentifier(callee)
    ? callee
    : ts.isPropertyAccessExpression(callee)
      ? callee.name
      : undefined;
  if (!id) return false;
  if (id.text === NAMEOF_NAME) return true;

  // Aliased import: resolve through the alias and check the real exported name.
  const symbol = checker.getSymbolAtLocation(callee);
  const target =
    symbol && symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  return target?.getName() === NAMEOF_NAME;
}

/** Collect class symbols annotated via a `forCtor(C)` call anywhere in `file`. */
function collectForCtorAnnotations(
  file: ts.SourceFile,
  checker: ts.TypeChecker,
): Set<ts.Symbol> {
  const annotated = new Set<ts.Symbol>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "forCtor" &&
      node.arguments.length >= 1
    ) {
      const arg = node.arguments[0]!;
      const symbol = checker.getSymbolAtLocation(arg);
      const target =
        symbol && symbol.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(symbol)
          : symbol;
      if (target) annotated.add(target);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return annotated;
}

/**
 * Returns the local identifier the file already binds `defineDeps` to (the
 * import's local name — honoring `import { defineDeps as x }` aliases), or
 * `undefined` if the file does not import it. When present we reuse this real,
 * source-bound identifier rather than injecting a duplicate import.
 */
function existingDefineDepsBinding(
  file: ts.SourceFile,
): ts.Identifier | undefined {
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const named = statement.importClause?.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        // `propertyName` is the imported (remote) name when aliased; otherwise
        // the local `name` is also the imported name.
        const importedName = (element.propertyName ?? element.name).text;
        if (importedName === DEFINE_DEPS) {
          return ts.factory.createIdentifier(element.name.text);
        }
      }
    }
  }
  return undefined;
}

/**
 * Prepend `import { defineDeps } from "@fnioc/di";` to the file. This is the
 * documented lowered-form contract (PRD §8): libraries compile with the
 * transformer and publish ESM, where this import + the bare `defineDeps(...)`
 * calls are exactly correct.
 *
 * CJS-output caveat: when emitting to CommonJS, TypeScript's module transformer
 * rewrites a named import to a namespace property access (`core_1.defineDeps`)
 * only for references it resolves through the binder. The transformer's emitted
 * `defineDeps(...)` calls are synthesized nodes that the binder never saw, so in
 * CJS output they stay bare and would dangle. The lowered form therefore targets
 * ESM output (the PRD §8 contract — libraries compile and publish ESM). Robust
 * CJS support (reconciling a generated-import-reference with the module
 * namespace) is a follow-up; until then, compile to ESM.
 */
function injectDefineDepsImport(
  file: ts.SourceFile,
  factory: ts.NodeFactory,
): ts.SourceFile {
  const importDecl = factory.createImportDeclaration(
    undefined,
    factory.createImportClause(
      false,
      undefined,
      factory.createNamedImports([
        factory.createImportSpecifier(
          false,
          undefined,
          factory.createIdentifier(DEFINE_DEPS),
        ),
      ]),
    ),
    factory.createStringLiteral(RUNTIME_MODULE),
  );
  return factory.updateSourceFile(file, [importDecl, ...file.statements]);
}

/** Best-effort project root: the program's common source directory. */
function computeProjectRoot(program: ts.Program): string {
  const opts = program.getCompilerOptions();
  if (opts.rootDir) return opts.rootDir.replace(/\\/g, "/");
  // `getCommonSourceDirectory` exists at runtime but is not in the public
  // typings; fall back to the current directory when unavailable.
  const withCommon = program as ts.Program & {
    getCommonSourceDirectory?: Func<[], string>;
  };
  const common = withCommon.getCommonSourceDirectory?.();
  return (common || program.getCurrentDirectory()).replace(/\\/g, "/");
}

// ── ts-patch program-transformer entry ───────────────────────────────────────

/**
 * Extras shape ts-patch passes to a program transformer. We only need
 * `addDiagnostic`; `ts` is the originating TypeScript instance.
 */
interface ProgramTransformerExtras {
  readonly ts: typeof ts;
  addDiagnostic(diagnostic: ts.Diagnostic): number;
}

/**
 * The ts-patch PROGRAM transformer entry point. Configure in `tsconfig.json`:
 *
 * ```jsonc
 * {
 *   "compilerOptions": {
 *     "plugins": [{ "transform": "@fnioc/transformer", "import": "transform" }]
 *   }
 * }
 * ```
 *
 * It does NOT alter the Program (it returns the same instance); the rewrite
 * runs via the returned `before` transformer factory during emit. Returning a
 * `TransformerBasePlugin` (with `before`) keeps TypeChecker access while letting
 * tsc drive the emit pipeline.
 */
export function transform(
  program: ts.Program,
  _config: unknown,
  extras: ProgramTransformerExtras,
): { before: ts.TransformerFactory<ts.SourceFile> } {
  const sink: DiagnosticSink = {
    addDiagnostic: (d) => extras.addDiagnostic(d),
  };
  return { before: createTransformerFactory(program, sink) };
}

export default transform;
