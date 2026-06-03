import type {
  DepSlot,
  DepRecord,
  DepTarget,
  FactoryRef,
  Union,
} from "./types.js";
import { store } from "./store.js";

/** True when `slot` is a `FactoryRef` (carries a `.type` token). */
export function isFactoryRef(slot: DepSlot): slot is FactoryRef {
  return (
    typeof slot === "object" &&
    slot !== null &&
    typeof (slot as { type?: unknown }).type === "string"
  );
}

/** True when `slot` is a `ScopeRef` (the live-scope marker `{ scope: true }`). */
export function isScopeRef(slot: DepSlot): boolean {
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
 * Structural equality of two signature slots:
 *   - two `FactoryRef`s are equal iff their `.type` tokens match and their
 *     `.params` arrays are element-wise identical (or both absent),
 *   - two `ScopeRef`s are always equal,
 *   - two `Union`s are equal iff their `union` arrays are element-wise equal
 *     under recursive `slotsEqual`,
 *   - strings compare by value,
 *   - slots of different kinds are never equal.
 */
function slotsEqual(a: DepSlot, b: DepSlot): boolean {
  const aIsRef = isFactoryRef(a);
  const bIsRef = isFactoryRef(b);
  if (aIsRef || bIsRef) {
    if (!aIsRef || !bIsRef) {return false;}
    if (a.type !== b.type) {return false;}
    const aParams = a.params ?? [];
    const bParams = b.params ?? [];
    if (aParams.length !== bParams.length) {return false;}
    for (let i = 0; i < aParams.length; i++) {
      if (aParams[i] !== bParams[i]) {return false;}
    }
    return true;
  }
  const aIsScope = isScopeRef(a);
  const bIsScope = isScopeRef(b);
  if (aIsScope || bIsScope) {
    return aIsScope && bIsScope;
  }
  const aIsUnion = isUnionSlot(a);
  const bIsUnion = isUnionSlot(b);
  if (aIsUnion || bIsUnion) {
    if (!aIsUnion || !bIsUnion) {return false;}
    if (a.union.length !== b.union.length) {return false;}
    for (let i = 0; i < a.union.length; i++) {
      if (!slotsEqual(a.union[i] as DepSlot, b.union[i] as DepSlot)) {return false;}
    }
    return true;
  }
  return a === b;
}

/** True when two positional signature arrays are element-wise identical. */
function signaturesEqual(a: readonly DepSlot[], b: readonly DepSlot[]): boolean {
  if (a.length !== b.length) {return false;}
  for (let i = 0; i < a.length; i++) {
    if (!slotsEqual(a[i] as DepSlot, b[i] as DepSlot)) {return false;}
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
 * @param target     The exact constructor OR factory function to annotate (no
 *                   prototype-chain walk — subclasses do NOT inherit the
 *                   parent's record).
 * @param signatures An array of signatures; each signature is a positional array
 *                   of DepSlot (Token | FactoryRef | ScopeRef | Union) parallel to
 *                   the target's parameter list.
 */
export function defineDeps(
  target: DepTarget,
  signatures: readonly (readonly DepSlot[])[],
): void {
  const existing = store.get(target);
  if (existing !== undefined) {
    const merged: (readonly DepSlot[])[] = [...existing.signatures];
    for (const sig of signatures) {
      if (!merged.some((s) => signaturesEqual(s, sig))) {
        merged.push(sig);
      }
    }
    store.set(target, { signatures: merged });
  } else {
    store.set(target, { signatures });
  }
}

/**
 * Reads the dependency metadata for a constructor or factory function from the
 * global WeakMap.
 *
 * Returns `undefined` when no metadata has been registered for `target`.
 * Keyed by the exact target — a subclass does NOT inherit the parent's
 * DepRecord.
 */
export function getDeps(target: DepTarget): DepRecord | undefined {
  return store.get(target);
}
