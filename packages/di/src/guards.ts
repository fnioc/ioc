// DepSlot type guards — the runtime discriminators the resolver uses to tell
// slot kinds apart. Relocated from @fnioc/core (now a pure-types package): the
// guards are runtime values, so they belong with the engine that runs them.

import type { DepSlot, FactoryRef, LiteralRef, ScopeRef, TypeArgRef, Union } from "@fnioc/core";

/** True when `slot` is a `FactoryRef` (carries a `.type` token). */
export function isFactoryRef(slot: DepSlot): slot is FactoryRef {
  return (
    typeof slot === "object" &&
    slot !== null &&
    typeof (slot as { type?: unknown }).type === "string"
  );
}

/** True when `slot` is a `ScopeRef` (the live-scope marker `{ scope: true }`). */
export function isScopeRef(slot: DepSlot): slot is ScopeRef {
  return (
    typeof slot === "object" &&
    slot !== null &&
    (slot as { scope?: unknown }).scope === true
  );
}

/** True when `slot` is a `Union` (carries a `.union` array of member slots). */
export function isUnionSlot(slot: DepSlot): slot is Union {
  return (
    typeof slot === "object" &&
    slot !== null &&
    Array.isArray((slot as { union?: unknown }).union)
  );
}

/**
 * True when `slot` is a `LiteralRef` — an object slot carrying a `value` key.
 * The value supplies a singular literal directly (`"dev"`, `42`, `true`, `1n`)
 * OR the lone inhabitant of `void` / `undefined` / `null`.
 *
 * Identified by the PRESENCE of the `value` key (`"value" in slot`), never by
 * `value !== undefined` — `value` is legitimately `undefined` for the
 * `void`/`undefined` case. No other slot kind (FactoryRef `.type`, ScopeRef
 * `.scope`, Union `.union`) carries a `value` key, so this is unambiguous.
 */
export function isLiteralRef(slot: DepSlot): slot is LiteralRef {
  return typeof slot === "object" && slot !== null && "value" in slot;
}

/**
 * True when `slot` is a `TypeArgRef` — an object slot carrying a numeric
 * `typeArg` key (the 1-based hole number). Key-disjoint from every other slot
 * kind (FactoryRef `.type`, ScopeRef `.scope`, Union `.union`, LiteralRef
 * `.value`), so the check is unambiguous.
 */
export function isTypeArgRef(slot: DepSlot): slot is TypeArgRef {
  return (
    typeof slot === "object" &&
    slot !== null &&
    typeof (slot as { typeArg?: unknown }).typeArg === "number"
  );
}
