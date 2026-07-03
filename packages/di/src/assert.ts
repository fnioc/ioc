/**
 * Exhaustiveness helper: reaching this at runtime means a `switch` over a
 * discriminated union missed a variant. Inlined locally so the published engine
 * carries zero runtime dependencies.
 */
export function assertNever(value: never): never {
  throw new TypeError(`Unreachable variant: ${JSON.stringify(value)}`);
}
