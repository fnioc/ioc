// The registration builder. Holds the base token → registration list map and
// mints the root Scope. `.add()` is the sole registration surface: the
// transformer lowers the type-driven authoring form to it, and the explicit
// token forms (class / useFactory / useValue) are the plugin-less mechanism for
// overrides, test doubles, and third-party wiring.

import type { Token } from "@fnioc/core";

import { Scope } from "./scope.js";
import type {
  ClassRegistration,
  Ctor,
  FactorySpec,
  Registration,
  ResolveScope,
  ValueSpec,
} from "./types.js";

/**
 * The continuation returned by a class `DiBuilder.add`. Carries the just-added
 * registration so `.as()` can attach its lifetime in place. An `.add()` with no
 * trailing `.as()` leaves the registration scopeless ⇒ transient.
 *
 * `Scopes` is threaded so `.as()` only accepts a declared scope name —
 * compile-time captive-misconfiguration guard at the registration site.
 */
export interface AddBuilder<Scopes extends string> {
  /**
   * Attaches the lifetime. Must name a declared scope.
   *
   * Two call shapes, by design (PRD §7):
   *   - AUTHORED   `.as<"singleton">()` — the scope name is a TYPE argument; the
   *     `S extends Scopes` bound is the compile-time captive-misconfiguration
   *     guard. No value argument is passed; this form is never executed (the
   *     transformer rewrites it before it runs).
   *   - LOWERED    `.as("singleton")` — the transformer rewrites the type
   *     argument to a value argument. This is the form the engine executes; the
   *     runtime reads the scope from the value arg.
   *
   * `scope` is therefore OPTIONAL at the type level: the authored form supplies
   * it as a type arg only, the lowered form as a value. A bare `.as()` with no
   * type arg leaves `S = Scopes` and is a degenerate (scopeless) call — use the
   * type arg.
   */
  as<S extends Scopes>(scope?: S): void;
}

/**
 * The registration builder.
 *
 * `Root` is the root scope's name (the app-lifetime tag singletons bind to);
 * `Children` is the union of declarable child-scope names. The scopes
 * `.as()`/`.createScope` accept are `Root | Children`. `"transient"` is NOT a
 * member — transient is the absence of a scope, not a scope.
 *
 * @example
 * ```ts
 * const services = new DiBuilder<"singleton", "request">();
 * services.add("pkg:ILogger", ConsoleLogger).as("singleton"); // lowered form
 * const root = services.build();                  // mints the "singleton" root
 * const logger = root.resolve<ILogger>("pkg:ILogger");
 * const req = root.createScope("request");        // nested child scope
 * ```
 */
export class DiBuilder<
  Root extends string = "singleton",
  Children extends string = never,
> {
  /**
   * The service collection: each token maps to a LIST of registrations in
   * registration order. Registering a token appends; resolution picks the
   * most-recent (last) registration. Earlier registrations are retained, which
   * is what lets a later `.add()` override an earlier one without deletion.
   */
  private readonly registrations = new Map<Token, Registration[]>();

  /**
   * The root scope's runtime name. `Root` is erased at runtime, so the name is
   * captured at construction (defaulting to `"singleton"`, matching the `Root`
   * default). Most callers never set it — the default covers the common
   * `DiBuilder<"singleton", …>` case; pass it only when `Root` is non-default.
   */
  private readonly rootName: Root | "singleton";

  public constructor(rootName?: Root) {
    this.rootName = rootName ?? "singleton";
  }

  /** Appends a registration to `token`'s list, creating the list on first use. */
  private append(token: Token, registration: Registration): void {
    const existing = this.registrations.get(token);
    if (existing === undefined) {
      this.registrations.set(token, [registration]);
    } else {
      existing.push(registration);
    }
  }

  /**
   * Type-only authoring overload — the form the transformer rewrites FROM. The
   * concrete is typed `new (...args: any[]) => I` (plain `new`, so an abstract
   * class is rejected). At runtime the engine only ever receives the
   * string-token form below; this signature exists purely so type-driven
   * authoring type-checks before the transformer lowers it.
   */
  public add<I>(ctor: new (...args: any[]) => I): AddBuilder<Root | Children>;
  /**
   * Class registration — a string token bound to a concrete constructor.
   * Returns the `.as(scope?)` continuation that attaches the lifetime. This is
   * what the transformer emits and what the engine actually executes.
   */
  public add(token: Token, ctor: Ctor): AddBuilder<Root | Children>;
  /**
   * Factory registration — a `useFactory` closure resolving its own deps from
   * the scope passed to it, with an optional `scope` caching its result at the
   * matching ancestor. Returns the builder for chaining.
   */
  public add<T>(token: Token, spec: FactorySpec<T>): this;
  /**
   * Value registration — the instance itself, no lifetime. Returns the builder
   * for chaining.
   */
  public add<T>(token: Token, spec: ValueSpec<T>): this;
  public add(
    tokenOrCtor: Token | (new (...args: any[]) => unknown),
    specOrCtor?: Ctor | FactorySpec<unknown> | ValueSpec<unknown>,
  ): AddBuilder<Root | Children> | this {
    // Only the string-token form reaches the engine at runtime. The type-only
    // overload is never actually invoked post-transform; guard defensively so a
    // hand-written type-form call fails loud rather than registering garbage.
    if (typeof tokenOrCtor !== "string" || specOrCtor === undefined) {
      throw new TypeError(
        'add<I>(ctor) requires the @fnioc/transformer plugin. Without it, ' +
          'register with an explicit token: add("my:token", MyClass).',
      );
    }

    const token = tokenOrCtor;

    // useValue: the instance itself, no lifetime.
    if (typeof specOrCtor === "object" && "useValue" in specOrCtor) {
      this.append(token, { kind: "value", useValue: specOrCtor.useValue });
      return this;
    }

    // useFactory: a closure with an optional caching scope.
    if (typeof specOrCtor === "object" && "useFactory" in specOrCtor) {
      this.append(token, {
        kind: "factory",
        useFactory: specOrCtor.useFactory as (scope: ResolveScope) => unknown,
        scope: specOrCtor.scope,
      });
      return this;
    }

    // Class registration: a concrete constructor. Appended scopeless (transient)
    // here; `.as()` appends a fresh scoped record so the array's last entry wins.
    const ctor = specOrCtor as Ctor;
    const registration: ClassRegistration = {
      kind: "class",
      ctor,
      scope: undefined,
    };
    this.append(token, registration);

    const append = (next: Registration): void => this.append(token, next);
    return {
      as<S extends Root | Children>(scope?: S): void {
        // The lowered form always passes a value arg; the authored type-arg-only
        // form never executes (the transformer rewrites it first). A no-arg call
        // at runtime would leave the registration transient — guard so it is a
        // no-op rather than appending a scopeless duplicate.
        if (scope === undefined) return;
        append({ ...registration, scope });
      },
    };
  }

  /**
   * Mints the root scope. The root is a real, app-lifetime object — its name is
   * `Root` (the lifetime that singletons, or whatever the app's longest
   * lifetime is, bind to). No argument: `build()` owns the root name via the
   * `Root` type parameter.
   */
  public build(): Scope<Root | Children> {
    return new Scope<Root | Children>(
      this.rootName as Root | Children,
      undefined,
      this.registrations,
    );
  }
}
