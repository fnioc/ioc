// `nameof<T>()` — the compile-time token mechanism (PRD §8 "Token generation").
//
// At the authoring level `nameof<IFoo>()` is a generic function whose return
// type is a plain `string`. The transformer rewrites each `nameof<IFoo>()` CALL
// in source to the derived string token at compile time, so callers never ship
// the generation logic to runtime.
//
// The runtime body exists only so that un-transformed code fails loudly instead
// of silently returning `undefined` — if you call `nameof` without the
// transformer wired up, you get a clear error pointing at the missing plugin.

/**
 * Compile-time token for a type. Rewritten by the @fnioc transformer to a
 * string literal; the runtime body only runs when the transformer is absent.
 *
 * @example
 * ```ts
 * const key = nameof<IUserRepo>(); // → "pkg:contracts/IUserRepo" at compile time
 * ```
 */
export function nameof<T>(): string {
  void (0 as unknown as T);
  throw new Error(
    "nameof<T>() was called without the @fnioc/transformer ts-patch plugin. " +
      "Add it to your tsconfig `plugins` (see @fnioc/transformer README), or " +
      "use a hand-authored token string instead.",
  );
}

/** The exported identifier name the transformer recognizes as `nameof`. */
export const NAMEOF_NAME = "nameof";
