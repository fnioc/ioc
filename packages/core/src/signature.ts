import type { Ctor, Func } from "@rhombus-toolkit/func";
import type { DepSlot } from "./types.js";
import { defineDeps } from "./defineDeps.js";

/**
 * TC39 class decorator factory that registers one constructor signature.
 *
 * Stacking multiple `@signature` decorators registers multiple overloads.
 * TypeScript evaluates class decorators bottom-up, so the bottom-most
 * `@signature` call runs first and appends first; tests should assert that
 * ALL signatures are present rather than relying on a specific order.
 *
 * Returns `void` — does not replace the class.
 *
 * @example
 * ```ts
 * // Two overloads: one with a logger, one without
 * @signature("pkg:ILogger", "pkg:IDb")
 * @signature("pkg:IDb")
 * class MyService {
 *   constructor(logOrDb: ILogger | IDb, db?: IDb) { ... }
 * }
 * ```
 */
export function signature(
  ...tokens: readonly DepSlot[]
): Func<[Ctor, ClassDecoratorContext], void> {
  return (value: Ctor, _context: ClassDecoratorContext): void => {
    defineDeps(value, [tokens.slice()]);
  };
}
