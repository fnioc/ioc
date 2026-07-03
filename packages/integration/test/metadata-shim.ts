// Test-only ergonomic for hand-feeding dep signatures without the transformer.
//
// The global metadata store is retired: signatures now ride ON the registration
// (`add(token, ctor, [[...]])`). To keep the plentiful `defineDeps(C, sig); …
// add(tok, C)` fixtures readable, this module stashes signatures in a WeakMap and
// patches `ServiceManifestClass.prototype.add`/`.addFactory` to thread a stashed
// signature in as the third argument when a call passes only `(token, target)`.
// The engine still sees exactly `registration.signatures` — pure authoring sugar
// over the inline third-argument form.

import { ServiceManifestClass } from "@fnioc/di";
import type { DepSlot } from "@fnioc/core";

type Signatures = readonly (readonly DepSlot[])[];

const testStore = new WeakMap<object, DepSlot[][]>();

/** Stash one-or-more signatures for `target`, appending to any prior stash. */
export function defineDeps(target: object, signatures: Signatures): void {
  const copies = signatures.map((sig) => [...sig]);
  const existing = testStore.get(target);
  if (existing !== undefined) {
    existing.push(...copies);
  } else {
    testStore.set(target, copies);
  }
}

/** Chainable fluent stash — one `.signature(...)` call per overload. */
export interface ForCtorBuilder {
  signature(...slots: DepSlot[]): ForCtorBuilder;
}
export function forCtor(ctor: object): ForCtorBuilder {
  const builder: ForCtorBuilder = {
    signature(...slots: DepSlot[]): ForCtorBuilder {
      defineDeps(ctor, [slots]);
      return builder;
    },
  };
  return builder;
}

type AddFn = (...args: unknown[]) => unknown;
function patchThirdArg(method: "add" | "addFactory"): void {
  const proto = ServiceManifestClass.prototype as unknown as Record<string, AddFn>;
  const original = proto[method]!;
  proto[method] = function (this: unknown, ...args: unknown[]): unknown {
    const target = args[1];
    if (
      args.length === 2 &&
      typeof args[0] === "string" &&
      (typeof target === "object" || typeof target === "function") &&
      target !== null
    ) {
      const stashed = testStore.get(target);
      if (stashed !== undefined) {
        return original.call(this, args[0], target, stashed);
      }
    }
    return original.apply(this, args);
  };
}
patchThirdArg("add");
patchThirdArg("addFactory");
