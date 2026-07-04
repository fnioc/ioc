// @fnioc/transformer — the ioc ts-patch compiler transformer.
//
// Build-time only. It provides token generation, dependency
// extraction via the TypeChecker, inline signature emission (the derived
// signature rides as the `add`/`addFactory` call's third argument), registration
// lowering (`add<I>(C).as<"x">()` → string-token form), `nameof<T>()` rewriting,
// and the edge-case behaviour (dynamic-class no-emission).
//
// It also performs factory detection (`() => IFoo` ctor params become
// `{ type: "<token>" }` slots) and emits the factory-signature and
// token-derivation diagnostics (see `deps.ts` + `checks.ts`).

// The type-only authoring surface this transformer contributes to `@fnioc/di`
// (`add<I>(C)`, `.as<"x">()`, `resolve<T>()`, …). Side-effect import: it carries
// a `declare module "@fnioc/di"` augmentation that must enter the program of any
// consumer that references `@fnioc/transformer`'s types.
import "./augment.js";

// The overload-faithful parameter-tuple utilities, re-exported so a consumer can
// type a factory's rest parameter (`(...args: OverloadedConstructorParameters<
// typeof C>) => I`) without importing `@fnioc/core` directly — an example app
// depends on `@fnioc/transformer` for the plugin already, so this is the same
// "one import reaches the whole authoring surface" gateway `augment.ts` itself
// documents. Re-exported from `./augment.js` (not `@fnioc/core` directly) so
// there is exactly one place that names the upstream package.
export type { OverloadedParameters, OverloadedConstructorParameters } from "./augment.js";

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
  injectTokenFor,
  holeNumberFor,
  type DeriveFailure,
  type TokenContext,
  type TokenResult,
} from "./tokens.js";
export {
  extractSignatureFromClass,
  extractFromExpression,
  extractInstantiatedSignature,
  isFactorySlot,
  isScopeSlot,
  isUnionSlot,
  isTypeArgSlot,
  slotsEqual,
  type Signature,
  type Slot,
  type FactorySlot,
  type ScopeSlot,
  type UnionSlot,
  type TypeArgSlot,
  type ConstructorExtraction,
  type DepContext,
} from "./deps.js";
export { type CheckContext } from "./checks.js";
export {
  DiagnosticCode,
  type Diagnostic,
  type DiagnosticSink,
  error,
  warning,
} from "./diagnostics.js";
