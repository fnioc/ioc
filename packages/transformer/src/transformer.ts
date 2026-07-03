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
//   1. Lowers each registration statement (`add<I>(C).as<"x">()` → string form),
//      carrying the derived dep signature inline as the call's third argument.
//   2. Rewrites every `nameof<T>()` and tokenless `resolve<T>()` call to its
//      string token.

import ts from "typescript";
import type { Func } from "@rhombus-toolkit/func";
import { literalExpression, lowerStatement, type LowerContext } from "./lower.js";
import {
  deriveToken,
  tokenForReturnType,
  tokenForType,
  injectTokenFor,
  singletonValue,
  type TokenContext,
} from "./tokens.js";
import {
  DiagnosticCode,
  error,
} from "./diagnostics.js";
import type { DiagnosticSink } from "./diagnostics.js";
import { NAMEOF_NAME } from "./nameof.js";

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
      // Default-lib types (`Promise`, `Map`) tokenize by bare name — their lib
      // path is machine-dependent and carries no identity.
      isDefaultLib: (file) => program.isSourceFileDefaultLibrary(file),
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
  const lowerCtx: LowerContext = {
    ...ctx,
    sourceFile,
  };

  // Lower registration statements (carrying the inline signature 3rd arg), and
  // within every remaining node, rewrite nameof<T>() and resolve<T>() calls.
  const statements = lowerStatements(sourceFile.statements, lowerCtx);

  return ts.factory.updateSourceFile(sourceFile, statements);
}

/**
 * Lower each top-level statement: a registration statement is rewritten in place
 * (its signature carried inline as the third `add` argument); all statements then
 * get a nameof + resolve rewrite pass.
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
  if (!ts.isPropertyAccessExpression(callee)) {return false;}
  if (callee.name.text !== "resolve") {return false;}
  if (!call.typeArguments || call.typeArguments.length !== 1) {return false;}
  return !call.arguments.length;
}

/**
 * `*.resolve<I>()` → `*.resolve("tok")` / `*.resolveFactory("tok:return", [...])`.
 *
 * Rule 2: a SINGULAR type arg (`resolve<"dev">()`, `resolve<42>()`,
 * `resolve<void>()`, `resolve<null>()`) supplies its value directly — the whole
 * call lowers to the value EXPRESSION itself (`"dev"`, `42`, `void 0`, `null`),
 * no container round-trip. A literal/nullish UNION (`"a" | "b"`, `Foo | undefined`)
 * stays a normal `resolve("<token>")` (singletonValue returns undefined for a union).
 */
function lowerResolveCall(
  call: ts.CallExpression,
  ctx: LowerContext,
): ts.Expression {
  const callee = call.expression as ts.PropertyAccessExpression;
  const typeArg = call.typeArguments![0]!;

  // Rule 2: singular T → emit the value, not a resolve call.
  if (!ts.isFunctionTypeNode(typeArg)) {
    const singleton = singletonValue(ctx.checker.getTypeFromTypeNode(typeArg));
    if (singleton) {
      return literalExpression(singleton.value, ctx.factory);
    }
  }

  let method = "resolve";
  let token: string | undefined;
  let paramTokens: string[] | undefined;

  if (ts.isFunctionTypeNode(typeArg)) {
    method = "resolveFactory";
    const signature = ctx.checker.getSignatureFromDeclaration(typeArg);
    token = signature ? tokenForReturnType(signature, ctx) : undefined;

    // Extract parameter tokens for the resolveFactory call (design §2).
    // Each param in the function type must tokenize; a param that cannot is a
    // hard error (same diagnostic as ctor params).
    if (signature) {
      paramTokens = [];
      for (const paramSym of signature.parameters) {
        const decl = paramSym.valueDeclaration;
        if (!decl || !ts.isParameter(decl)) {
          paramTokens = undefined;
          break;
        }
        const paramType = ctx.checker.getTypeAtLocation(decl);
        // Check Inject brand first.
        const branded = injectTokenFor(paramType, ctx.checker);
        if (branded !== undefined) {
          paramTokens.push(branded);
          continue;
        }
        const result = tokenForType(paramType, ctx);
        if (result !== undefined) {
          paramTokens.push(result.token);
        } else {
          // Hard error: param in resolveFactory<(...) => T> cannot tokenize.
          ctx.sink.addDiagnostic(
            error(
              ctx.sourceFile,
              decl.type ?? decl,
              DiagnosticCode.UnderivableToken,
              "cannot derive a token for this type — name the type or brand the parameter with `Inject<T, 'my:token'>`",
            ),
          );
          paramTokens.push("??unresolvable??");
        }
      }
    }
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

  // Build the argument list: always token, then params array if non-empty.
  const args: ts.Expression[] = [tokenLiteral];
  if (paramTokens && paramTokens.length) {
    args.push(
      ctx.factory.createArrayLiteralExpression(
        paramTokens.map((p) => ctx.factory.createStringLiteral(p)),
        false,
      ),
    );
  }

  return ctx.factory.updateCallExpression(call, newCallee, undefined, args);
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
  if (!call.typeArguments || call.typeArguments.length !== 1) {return false;}
  const callee = call.expression;
  const id = ts.isIdentifier(callee)
    ? callee
    : ts.isPropertyAccessExpression(callee)
      ? callee.name
      : undefined;
  if (!id) {return false;}
  if (id.text === NAMEOF_NAME) {return true;}

  // Aliased import: resolve through the alias and check the real exported name.
  const symbol = checker.getSymbolAtLocation(callee);
  const target =
    symbol && symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  return target?.getName() === NAMEOF_NAME;
}

/** Best-effort project root: the program's common source directory. */
function computeProjectRoot(program: ts.Program): string {
  const opts = program.getCompilerOptions();
  if (opts.rootDir) {return opts.rootDir.replace(/\\/g, "/");}
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
