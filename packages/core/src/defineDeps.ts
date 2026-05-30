import type { DepSlot, DepRecord, FactoryRef } from "./types.js";
import { ABI_VERSION, store } from "./store.js";

/** True when `slot` is a `FactoryRef` (carries a `.factory` token). */
function isFactoryRef(slot: DepSlot): slot is FactoryRef {
  return typeof slot === "object" && slot !== null;
}

/**
 * Structural equality of two signature slots:
 *   - two `FactoryRef`s are equal iff their `.factory` tokens match,
 *   - strings compare by value, `null` by identity,
 *   - slots of different kinds are never equal.
 */
function slotsEqual(a: DepSlot, b: DepSlot): boolean {
  const aIsRef = isFactoryRef(a);
  const bIsRef = isFactoryRef(b);
  if (aIsRef || bIsRef) {
    return aIsRef && bIsRef && a.factory === b.factory;
  }
  return a === b;
}

/** True when two positional signature arrays are element-wise identical. */
function signaturesEqual(
  a: ReadonlyArray<DepSlot>,
  b: ReadonlyArray<DepSlot>,
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!slotsEqual(a[i] as DepSlot, b[i] as DepSlot)) return false;
  }
  return true;
}

/**
 * The single write path into the global WeakMap.
 *
 * Both the transformer-emitted code and `@signature` / `forCtor` funnel through
 * this function. No other code writes to the store.
 *
 * Merge semantics: appends each incoming signature to the ctor's existing
 * DepRecord, deduping exact-equal signatures (same length + same elements in
 * order). Creates the record from scratch if the ctor is not yet registered.
 *
 * @param ctor       The exact constructor function to annotate (no prototype-
 *                   chain walk — subclasses do NOT inherit the parent's record).
 * @param signatures An array of signatures; each signature is a positional array
 *                   of DepSlot (Token | null | FactoryRef) parallel to the
 *                   constructor's parameter list.
 */
export function defineDeps(
  ctor: Function,
  signatures: ReadonlyArray<ReadonlyArray<DepSlot>>,
): void {
  const existing = store.get(ctor);
  if (existing !== undefined) {
    const merged: Array<ReadonlyArray<DepSlot>> = [...existing.signatures];
    for (const sig of signatures) {
      if (!merged.some((s) => signaturesEqual(s, sig))) {
        merged.push(sig);
      }
    }
    store.set(ctor, { abi: ABI_VERSION, signatures: merged });
  } else {
    store.set(ctor, { abi: ABI_VERSION, signatures });
  }
}

/**
 * Reads the dependency metadata for a constructor from the global WeakMap.
 *
 * Returns `undefined` when no metadata has been registered for `ctor`.
 * Keyed by the exact constructor — a subclass does NOT inherit the parent's
 * DepRecord.
 */
export function getDeps(ctor: Function): DepRecord | undefined {
  return store.get(ctor);
}
