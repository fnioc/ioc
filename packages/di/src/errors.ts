// Typed error classes for the runtime engine.
//
// Each failure mode the resolver can hit gets its own class so consumers can
// branch on `instanceof` rather than string-matching messages. Messages are
// written for a human reading a stack trace at the moment a graph fails to
// resolve.

import type { DepSlot, Token } from "@fnioc/core";

/** Base class for every error the container raises. */
export class DiError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * A token was requested but no registration exists for it anywhere in the
 * resolving scope's chain (nor on the builder's base map).
 */
export class UnregisteredTokenError extends DiError {
  public constructor(public readonly token: Token) {
    super(
      `No registration found for token "${token}". Register it with ` +
        `services.add(...) before resolving.`,
    );
  }
}

/**
 * A constructor with parameters has no DepRecord in the global-symbol Map — the
 * transformer never saw it and it was never hand-annotated.
 */
export class MissingMetadataError extends DiError {
  public constructor(
    public readonly token: Token,
    public readonly ctorName: string,
  ) {
    super(
      `No dep metadata found for ${ctorName} (resolving "${token}"). The ` +
        `constructor has parameters but no forCtor or ` +
        `transformer-generated defineDeps call was found. Use ` +
        `forCtor(...).signature(...) or register it with useFactory to wire ` +
        `it manually.`,
    );
  }
}

/**
 * A constructor has DepRecord signatures, but none of them is directly
 * satisfiable in the owning scope (every signature names at least one token
 * that is not registered, or contains a hole this phase cannot fill).
 */
export class NoSatisfiableSignatureError extends DiError {
  public constructor(
    public readonly token: Token,
    public readonly ctorName: string,
    public readonly unsatisfiable: readonly Token[],
  ) {
    super(
      `No satisfiable constructor signature for ${ctorName} (resolving ` +
        `"${token}"). Every candidate signature names a dependency that is ` +
        `not registered in the owning scope` +
        (unsatisfiable.length
          ? `; unsatisfiable tokens: ${unsatisfiable
              .map((t) => `"${t}"`)
              .join(", ")}`
          : "") +
        `. Register the missing dependencies, or provide a useFactory ` +
        `override.`,
    );
  }
}

/**
 * A token reappeared on the active resolution stack — the dependency graph has
 * a cycle. The message includes the full path that closed the loop.
 */
export class CircularDependencyError extends DiError {
  public constructor(public readonly path: readonly Token[]) {
    super(`Circular dependency detected:\n  ${path.join(" → ")}`);
  }
}

/**
 * A constructor parameter is typed as a factory of some token (a `FactoryRef`),
 * but that token cannot be turned into a factory: either it is not registered,
 * or it is registered as a `useValue` / `useFactory` override rather than a
 * class. A factory injects a callable that constructs the target class on
 * demand, so the target must be a class registration.
 */
export class FactoryTargetError extends DiError {
  public constructor(
    public readonly factoryToken: Token,
    public readonly reason: "unregistered" | "not-a-class",
  ) {
    super(
      reason === "unregistered"
        ? `Cannot inject a factory for "${factoryToken}": no registration ` +
            `found for it. A factory parameter (typed \`() => IFoo\`) needs ` +
            `the target registered as a class with ` +
            `services.add(...) before it can build instances.`
        : `Cannot inject a factory for "${factoryToken}": it is registered ` +
            `as a useValue/useFactory override, not a class. A factory builds ` +
            `its target with \`new\`, so the target must be a class ` +
            `registration. Resolve it directly instead of as a factory, or ` +
            `register the class with services.add(...).`,
    );
  }
}

/**
 * A `Union` slot was encountered during resolution but none of its member slots
 * was resolvable. Resolution cannot proceed without at least one registered member.
 */
export class NoSatisfiableUnionError extends DiError {
  public constructor(public readonly members: readonly DepSlot[]) {
    const memberList = members
      .map((m) => (typeof m === "string" ? `"${m}"` : JSON.stringify(m)))
      .join(", ");
    super(
      `No satisfiable union member found. Tried: [${memberList}]. ` +
        `Register at least one of the union members before resolving.`,
    );
  }
}

/**
 * A token that still contains holes (`$N`) was resolved. An open template is
 * not a resolvable token — it names a FAMILY of tokens, one per closing. The
 * caller must close it first (substitute every hole with a concrete arg token).
 */
export class OpenTokenResolutionError extends DiError {
  public constructor(public readonly token: Token) {
    super(
      `Cannot resolve open template "${token}": it still contains holes ` +
        `($N). Close the template first — resolve a concrete closing like ` +
        `"base<arg>" (see closeToken / substituteToken), not the template ` +
        `itself.`,
    );
  }
}

/**
 * An open template token was passed to a registration method that cannot
 * accept one: `addValue`/`addFactory` (open registrations are class-only), or
 * `add` with a template whose type arguments are not ALL holes (v1 forbids
 * mixing concrete args and holes in the service token).
 */
export class OpenTokenRegistrationError extends DiError {
  public constructor(
    public readonly token: Token,
    public readonly method: "add" | "addFactory" | "addValue",
  ) {
    super(
      method === "add"
        ? `Cannot register open template "${token}": every type argument of ` +
            `an open service token must be a hole ($N). Make every argument ` +
            `a hole, or close the token fully.`
        : `Cannot register open template "${token}" with ${method}(): open ` +
            `registrations are class-only. Register a class with ` +
            `add("${token}", MyClass), or close the token first.`,
    );
  }
}

/**
 * Sync `dispose()` was called on a scope that owns a Promise-valued (thenable)
 * cached instance. A pending Promise cannot be disposed synchronously — the
 * caller must use `disposeAsync()`.
 */
export class AsyncDisposalRequiredError extends DiError {
  public constructor() {
    super(
      `Cannot dispose synchronously: this scope owns a Promise-valued ` +
        `instance (an async useFactory result). Awaiting it is required ` +
        `before disposal — call disposeAsync() instead of dispose().`,
    );
  }
}
