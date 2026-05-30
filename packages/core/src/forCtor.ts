import type { DepSlot } from "./types.js";
import { defineDeps } from "./defineDeps.js";

/**
 * The builder returned by `forCtor`. Chainable — each `.signature()` call
 * appends one overload to the ctor's DepRecord.
 */
export interface ForCtorBuilder {
  /**
   * Appends one constructor signature (a positional array of DepSlot —
   * Token | null | FactoryRef) to the ctor's dependency metadata. Returns
   * `this` for chaining.
   *
   * Each `.signature(...)` call is one overload. Chaining two calls is
   * equivalent to stacking two `@signature` decorators.
   */
  signature(...tokens: ReadonlyArray<DepSlot>): ForCtorBuilder;
}

/**
 * Fluent free-function for registering dependency metadata on a constructor
 * without using a decorator — useful for third-party classes you do not own.
 *
 * @example
 * ```ts
 * forCtor(ThirdPartyService)
 *   .signature("pkg:IDb")
 *   .signature("pkg:ILogger", "pkg:IDb"); // second overload
 * ```
 */
export function forCtor(ctor: Function): ForCtorBuilder {
  const builder: ForCtorBuilder = {
    signature(...tokens: ReadonlyArray<DepSlot>): ForCtorBuilder {
      defineDeps(ctor, [tokens.slice()]);
      return builder;
    },
  };
  return builder;
}
