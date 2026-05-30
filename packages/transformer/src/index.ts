// @fnioc/transformer — the ioc ts-patch compiler transformer.
//
// Build-time only. Shares the ABI/token format from @fnioc/core and never
// depends on the @fnioc/di runtime. This phase (2B) ships token generation,
// dependency extraction via the TypeChecker, `defineDeps` emission, registration
// lowering (`add<I>(C).as<"x">()` → string-token form), `nameof<T>()` rewriting,
// and the basic edge-case behaviour (already-annotated skip + info diagnostic,
// dynamic-class no-emission).
//
// Phase 2D adds factory detection (`() => IFoo` ctor params becoming factory
// markers) and the factory-signature / async-mismatch / overload-ambiguity
// diagnostics. Those are intentionally NOT implemented here — see the
// `// Phase 2D:` markers in `tokens.ts` and `lower.ts`.

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
  type Signature,
  type ConstructorExtraction,
} from "./deps.js";
export {
  DiagnosticCode,
  type Diagnostic,
  type DiagnosticSink,
} from "./diagnostics.js";

/** The ABI version this transformer emits lowered calls for. */
export const TARGET_ABI_VERSION: number = ABI_VERSION;
