// The registration builder. Holds the base token → registration map and hands
// out a root Scope. `.add()` is the surface the transformer lowers to; the
// override paths (`.register`) are the recommended plugin-less mechanism.

import type { Token } from "@fnioc/core";

import { Scope } from "./scope.js";
import type {
  ClassRegistration,
  Ctor,
  OverrideSpec,
  Registration,
  ResolveScope,
} from "./types.js";

/**
 * The continuation returned by `DiBuilder.add`. Carries the just-added
 * registration so `.as()` can attach its lifetime tag in place. An `.add()`
 * with no trailing `.as()` leaves the registration untagged ⇒ transient.
 *
 * `Scopes` is threaded so `.as()` only accepts a declared scope name —
 * compile-time captive-misconfiguration guard at the registration site.
 */
export interface AddBuilder<Scopes extends string> {
  /** Attaches the lifetime tag. Must name a declared scope. */
  as<S extends Scopes>(scope: S): void;
}

/**
 * The registration builder.
 *
 * `Scopes` is the user-supplied scope-name union (e.g.
 * `"singleton" | "request"`). `"transient"` is NOT a member — transient is the
 * absence of a tag, not a scope.
 *
 * @example
 * ```ts
 * const services = new DiBuilder<"singleton" | "request">();
 * services.add("pkg:ILogger", ConsoleLogger).as("singleton"); // lowered form
 * const root = services.createScope("singleton");
 * const logger = root.resolve<ILogger>("pkg:ILogger");
 * ```
 */
export class DiBuilder<Scopes extends string = string> {
  private readonly registrations = new Map<Token, Registration>();

  /**
   * Type-only authoring overload — the form the transformer rewrites FROM. The
   * concrete is typed `new (...args: any[]) => I` (plain `new`, so an abstract
   * class is rejected). At runtime the engine only ever receives the
   * string-token form below; this signature exists purely so type-driven
   * authoring type-checks before the transformer lowers it.
   */
  public add<I>(ctor: new (...args: any[]) => I): AddBuilder<Scopes>;
  /**
   * The runtime reality — a string token bound to a concrete constructor. This
   * is what the transformer emits and what the engine actually executes.
   */
  public add(token: Token, ctor: Ctor): AddBuilder<Scopes>;
  public add(
    tokenOrCtor: Token | (new (...args: any[]) => unknown),
    maybeCtor?: Ctor,
  ): AddBuilder<Scopes> {
    // Only the string-token form reaches the engine at runtime. The type-only
    // overload is never actually invoked post-transform; guard defensively so a
    // hand-written type-form call fails loud rather than registering garbage.
    if (typeof tokenOrCtor !== "string" || maybeCtor === undefined) {
      throw new TypeError(
        "DiBuilder.add must be called with (token, ctor) at runtime. The " +
          "type-only add<I>(ctor) overload is lowered to that form by the " +
          "transformer and is never executed directly.",
      );
    }

    const registration: ClassRegistration = {
      kind: "class",
      ctor: maybeCtor,
      tag: undefined,
    };
    this.registrations.set(tokenOrCtor, registration);

    // `.as()` rebinds the registration with its tag. The map holds an immutable
    // record, so swap in a fresh one rather than mutating the readonly field.
    const token = tokenOrCtor;
    const registrations = this.registrations;
    return {
      as<S extends Scopes>(scope: S): void {
        registrations.set(token, { ...registration, tag: scope });
      },
    };
  }

  /**
   * The plugin-less override path. Registers a token against either a
   * `useFactory` closure (which resolves its own deps from the scope passed to
   * it) or a `useValue` instance. The recommended mechanism for test doubles,
   * third-party instances, and plugin-less wiring.
   *
   * A `useFactory` may carry an optional `tag` so the factory's result is
   * cached at a matching ancestor scope (singleton-style); without a tag it
   * runs on every resolve. A `useValue` is the instance itself — always the
   * same value, no lifetime.
   */
  public register<T>(token: Token, spec: OverrideSpec<T>): this {
    if ("useValue" in spec) {
      this.registrations.set(token, { kind: "value", useValue: spec.useValue });
    } else {
      this.registrations.set(token, {
        kind: "factory",
        useFactory: spec.useFactory as (scope: ResolveScope) => unknown,
        tag: spec.tag,
      });
    }
    return this;
  }

  /**
   * Mints the root scope. The root must be a real, app-lifetime object — its
   * name is the lifetime tag that singletons (or whatever the app's longest
   * lifetime is) bind to.
   */
  public createScope(rootScopeName: Scopes): Scope<Scopes> {
    return new Scope<Scopes>(rootScopeName, undefined, this.registrations);
  }
}
