/**
 * @fnioc/core — the immutable substrate and dependency-metadata format.
 *
 * Exports:
 *   - `Token`          — string alias for a DI key
 *   - `FactoryRef`     — marks a signature slot as a factory-injected parameter
 *   - `ScopeRef`       — marks a signature slot as the live resolution scope
 *   - `Union`          — member-level alternative slots tried in declaration order
 *   - `LiteralRef`     — a singular literal slot supplying its value directly
 *   - `TypeArgRef`     — a slot carrying the token string of a type argument
 *   - `DepSlot`        — one positional slot: Token | FactoryRef | ScopeRef | Union | LiteralRef | TypeArgRef
 *   - `Inject`         — compile-time brand that pins a token for one arg
 *   - `Hole`, `$`      — compile-time skolems for open-template type arguments (`$<N>` = `Hole<N>`)
 *   - `Typeof`         — compile-time brand: parameter receives a type argument's token
 *   - `DepTarget`      — a ctor or factory function a signature describes
 *   - `DepRecord`      — shape of per-constructor dependency metadata
 *   - `union`          — runtime helper: constructs a Union slot from member slots
 *   - `typeArg`        — runtime helper: constructs a TypeArgRef slot
 *   - `isFactoryRef`   — type guard for FactoryRef slots
 *   - `isScopeRef`     — type guard for ScopeRef slots
 *   - `isUnionSlot`    — type guard for Union slots
 *   - `isLiteralRef`   — type guard for LiteralRef slots
 *   - `isTypeArgRef`   — type guard for TypeArgRef slots
 *   - `ParsedToken`    — result shape of `parseToken`
 *   - `closeToken`     — renders the canonical closed-generic form `base<a,b>`
 *   - `parseToken`     — parses a closed-generic token into base + args
 *   - `isOpenToken`    — true when a token contains a hole (`$N`) at any depth
 *   - `substituteToken` — replaces hole nodes in an open template with arg tokens
 *   - `substituteSignatures` — substitutes arg tokens through dep signatures
 */

import type { DepSlot, TypeArgRef, Union } from "./types.js";

export type {
  Token,
  FactoryRef,
  ScopeRef,
  Union,
  LiteralRef,
  TypeArgRef,
  DepSlot,
  DepTarget,
  DepRecord,
  Inject,
  Hole,
  $,
  Typeof,
} from "./types.js";
export {
  isFactoryRef,
  isScopeRef,
  isUnionSlot,
  isLiteralRef,
  isTypeArgRef,
} from "./guards.js";
export type { ParsedToken } from "./tokens.js";
export {
  closeToken,
  parseToken,
  isOpenToken,
  substituteToken,
  substituteSignatures,
} from "./tokens.js";

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
