// @fnioc/transformer — the ioc ts-patch compiler transformer.
//
// Build-time only. Shares the ABI/token format from @fnioc/core and never
// depends on the @fnioc/di runtime. It provides token generation, dependency
// extraction via the TypeChecker, `defineDeps` emission, registration lowering
// (`add<I>(C).as<"x">()` → string-token form), `nameof<T>()` rewriting, and the
// edge-case behaviour (already-annotated skip + info diagnostic, dynamic-class
// no-emission).
//
// It also performs factory detection (`() => IFoo` ctor params become
// `{ factory: "<token>" }` slots) and emits the factory-signature /
// async-mismatch / overload-ambiguity diagnostics (see `deps.ts` + `checks.ts`).

import { ABI_VERSION } from "@fnioc/core";

// ts-patch entry point (default + named `transform`) and the test-drivable
// factory.
export {
  transform,
  default as transformer,
  createTransformerFactory,
} from "./transformer.js";

// `nameof<T>()` — the compile-time token mechanism (rewritten by the transformer).
export { nameof } from "./nameof.js";

// Token generation, dependency extraction, and diagnostics — exported so
// downstream tooling (and tests) can reuse the building blocks.
export {
  deriveToken,
  tokenForType,
  type TokenContext,
  type TokenResult,
} from "./tokens.js";
export {
  extractSignatureFromClass,
  extractFromExpression,
  hasSignatureDecorator,
  isFactorySlot,
  type Signature,
  type Slot,
  type FactorySlot,
  type ConstructorExtraction,
} from "./deps.js";
export { collectAsyncTokens, type CheckContext } from "./checks.js";
export {
  DiagnosticCode,
  type Diagnostic,
  type DiagnosticSink,
} from "./diagnostics.js";

/** The ABI version this transformer emits lowered calls for. */
export const TARGET_ABI_VERSION: number = ABI_VERSION;
