// @fnioc/di — the ioc runtime engine.
//
// Full implementation lands in Phase 2A (see PLAN.md): DiBuilder, the scope
// chain + tagged lifetimes, resolution, the captive-dependency rule, cycle
// detection, disposal (sync + async), factories, and the useFactory/useValue
// override paths. For now this re-exports the ABI version from @fnioc/core to
// smoke-test cross-package resolution and the project reference.

import { ABI_VERSION } from "@fnioc/core";

/** Re-exported for diagnostics; confirms the runtime resolves the substrate. */
export const SUBSTRATE_ABI_VERSION: number = ABI_VERSION;
