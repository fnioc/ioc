// Slot constructors — runtime sugar for hand-authoring signature slots. Relocated
// from @fnioc/core (now a pure-types package). A di consumer imports these for
// ergonomics; a core-only library author authors the same shapes as plain data
// literals (`{ union: [...] }`, `{ typeArg: n }`).

import type { DepSlot, TypeArgRef, Union } from "@fnioc/core";

/**
 * Constructs a `Union` slot — a set of alternative dependency slots tried in
 * declaration order. The first resolvable member wins; if none is resolvable,
 * resolution throws.
 *
 * @example
 * ```ts
 * services.add("pkg:IHandler", Handler, [[
 *   union("pkg:IRedis", "pkg:IMemoryCache"),
 *   "pkg:ILogger",
 * ]]);
 * ```
 */
export function union(...slots: DepSlot[]): Union {
  return { union: slots };
}

/**
 * Constructs a `TypeArgRef` slot — a parameter that receives the TOKEN STRING
 * of the registration's `n`th type argument (1-based, matching `$n`). Used on
 * the manual authoring surface for hole-template signatures; substitution
 * closes it into a literal value slot per closing.
 *
 * @example
 * ```ts
 * services.add("app/IRepo<$1>", SqlRepository, [[typeArg(1), "app/IDb"]]);
 * ```
 */
export function typeArg(n: number): TypeArgRef {
  return { typeArg: n };
}
