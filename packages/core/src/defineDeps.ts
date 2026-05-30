import type { Token, DepRecord } from "./types.js";
import { ABI_VERSION, store } from "./store.js";

/** True when two positional signature arrays are element-wise identical. */
function signaturesEqual(
  a: ReadonlyArray<Token | null>,
  b: ReadonlyArray<Token | null>,
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
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
 *                   of Token | null parallel to the constructor's parameter list.
 */
export function defineDeps(
  ctor: Function,
  signatures: ReadonlyArray<ReadonlyArray<Token | null>>,
): void {
  const existing = store.get(ctor);
  if (existing !== undefined) {
    const merged: Array<ReadonlyArray<Token | null>> = [...existing.signatures];
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
