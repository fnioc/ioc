// Typed error classes for the runtime engine.
//
// Each failure mode the resolver can hit gets its own class so consumers can
// branch on `instanceof` rather than string-matching messages. Messages are
// written for a human reading a stack trace at the moment a graph fails to
// resolve.

import type { Token } from "@fnioc/core";

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
        `services.add(...)/.register(...) before resolving.`,
    );
  }
}

/**
 * A registration carries a lifetime tag, but no ancestor scope in the resolving
 * chain has a matching name. This is the captive-dependency / misconfiguration
 * detector — the engine never auto-creates a scope to satisfy the tag.
 */
export class MissingScopeError extends DiError {
  public constructor(
    public readonly token: Token,
    public readonly tag: string,
    public readonly availableScopes: readonly string[],
  ) {
    super(
      `Cannot resolve "${token}": its lifetime is tagged "${tag}", but no ` +
        `ancestor scope with that name exists in the resolving chain ` +
        `(available: ${
          availableScopes.length > 0
            ? availableScopes.map((s) => `"${s}"`).join(" → ")
            : "none"
        }). ` +
        `This usually means a longer-lived service depends on a ` +
        `shorter-lived one (e.g. a "singleton" needing a "request"). Never ` +
        `auto-created — fix the registration's lifetime or create the scope.`,
    );
  }
}

/**
 * A constructor with parameters has no DepRecord in the WeakMap — the
 * transformer never saw it and it was never hand-annotated.
 */
export class MissingMetadataError extends DiError {
  public constructor(
    public readonly token: Token,
    public readonly ctorName: string,
  ) {
    super(
      `No dep metadata found for ${ctorName} (resolving "${token}"). The ` +
        `constructor has parameters but no @signature, forCtor, or ` +
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
        (unsatisfiable.length > 0
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
