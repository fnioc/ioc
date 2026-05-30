// @fnioc/transformer — the ioc ts-patch compiler transformer.
//
// Full implementation lands in Phase 2B (see PLAN.md): token generation,
// dependency extraction via the TypeChecker, `defineDeps` emission,
// registration lowering, and the factory-signature diagnostic. Build-time
// only — it shares the ABI/token format from @fnioc/core and never depends on
// the @fnioc/di runtime.
//
// For now this exports the ABI version it targets, so the published lowering
// can be matched against the runtime's `ABI_VERSION` at integration time.

import { ABI_VERSION } from "@fnioc/core";

/** The ABI version this transformer emits lowered calls for. */
export const TARGET_ABI_VERSION: number = ABI_VERSION;
