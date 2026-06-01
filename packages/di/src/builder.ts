// The registration builder. Holds the base token → registration list map and
// mints the root Scope. Three registration surfaces:
//   - `add`        — a class (its ctor deps are injected),
//   - `addFactory` — a factory function (its call-param deps are injected),
//   - `addValue`   — an already-built instance (no deps, no lifetime).
// The transformer lowers the type-driven authoring forms (`add<I>(C)`,
// `add<I>(fn)`, `addValue<I>(v)`) to these; the explicit-token forms are the
// plugin-less mechanism for overrides, test doubles, and third-party wiring.
// `add<I>(fn)` (a factory) lowers to `addFactory("token", fn)` — the transformer
// statically knows the arg is a function, so the runtime never has to guess
// class-vs-factory.

import type { Token } from "@fnioc/core";

import { Scope } from "./scope.js";
import type {
  ClassRegistration,
  Ctor,
  FactoryRegistration,
  Factory,
  Registration,
  ResolveScope,
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
   * Appends a scopeless `class`/`factory` base registration and returns the
   * `.as(scope?)` continuation. `.as()` appends a fresh SCOPED copy so the
   * array's last entry wins; a bare `.add(...)`/`.addFactory(...)` with no
   * trailing `.as()` leaves the base (transient) registration in place.
   */
  private appendScoped(
    token: Token,
    base: ClassRegistration | FactoryRegistration,
  ): AddBuilder<Root | Children> {
    this.append(token, base);
    const append = (next: Registration): void => this.append(token, next);
    return {
      as<S extends Root | Children>(scope?: S): void {
        // The lowered form always passes a value arg; the authored type-arg-only
        // form never executes (the transformer rewrites it first). A no-arg call
        // at runtime would leave the registration transient — guard so it is a
        // no-op rather than appending a scopeless duplicate.
        if (scope === undefined) return;
        append({ ...base, scope });
      },
    };
  }

  /**
   * Type-only authoring overloads — the forms the transformer rewrites FROM:
   *   - `add<I>(C)`  → `add("token", C)`            (class)
   *   - `add<I>(fn)` → `addFactory("token", fn)`    (factory; the transformer
   *     knows the arg is a function and routes it to `addFactory`).
   * The ctor is typed `Ctor<any[], I>` (plain construct signature, so an
   * abstract class is rejected); the factory is any `(...args) => I`. Neither
   * runs post-transform — they exist purely so type-driven authoring
   * type-checks before lowering.
   */
  public add<I>(ctor: Ctor<any[], I>): AddBuilder<Root | Children>;
  public add<I>(factory: (...args: any[]) => I): AddBuilder<Root | Children>;
  /**
   * Class registration — a string token bound to a concrete constructor. The
   * runtime form: what the transformer emits for a class, and what a
   * plugin-less caller writes directly. Returns the `.as(scope?)` continuation.
   */
  public add(token: Token, ctor: Ctor): AddBuilder<Root | Children>;
  public add(
    ...args:
      | [ctor: Ctor<any[], unknown>]
      | [factory: (...args: any[]) => unknown]
      | [token: Token, ctor: Ctor]
  ): AddBuilder<Root | Children> {
    // Only the two-arg string-token form reaches the engine at runtime. The
    // single-arg authoring overloads never run post-transform; guard defensively
    // so a hand-written type-form call fails loud rather than registering junk.
    if (args.length === 1 || typeof args[0] !== "string") {
      throw new TypeError(
        "add<I>(ctor) / add<I>(factory) require the @fnioc/transformer plugin. " +
          'Without it, register with an explicit token: add("my:token", MyClass) ' +
          "or addFactory(\"my:token\", (scope) => ...).",
      );
    }
    const [token, ctor] = args;
    return this.appendScoped(token, {
      kind: "class",
      ctor: ctor as Ctor,
      scope: undefined,
    });
  }

  /**
   * Factory registration — a string token bound to a factory function. The
   * runtime form the transformer emits for an authored `add<I>(fn)`, and what a
   * plugin-less caller writes directly.
   *
   * Parameter injection follows the metadata rule (see `Scope.instantiate`): a
   * factory WITH a `defineDeps` record (emitted by the transformer) has each
   * parameter injected by its slot; a record-less factory (the plugin-less
   * escape hatch) is called with the live scope — type it `(scope: ResolveScope)
   * => T` and `scope.resolve(...)` its own deps. Returns the `.as(scope?)`
   * continuation so a factory caches at a named scope exactly like a class.
   */
  public addFactory(
    token: Token,
    factory: (scope: ResolveScope) => unknown,
  ): AddBuilder<Root | Children>;
  public addFactory(
    token: Token,
    factory: Factory,
  ): AddBuilder<Root | Children> {
    return this.appendScoped(token, {
      kind: "factory",
      factory,
      scope: undefined,
    });
  }

  /**
   * Value registration — an already-built instance, no deps and no lifetime.
   * Separate from `add` because a value may itself be a function (a callable
   * service), which is structurally indistinguishable from a factory inside one
   * overload. Authoring `addValue<I>(v)` lowers to `addValue("token", v)`.
   */
  public addValue<I>(value: I): void;
  public addValue(token: Token, value: unknown): void;
  public addValue(
    ...args: [value: unknown] | [token: Token, value: unknown]
  ): void {
    if (args.length === 1 || typeof args[0] !== "string") {
      throw new TypeError(
        "addValue<I>(value) requires the @fnioc/transformer plugin. Without it, " +
          'register with an explicit token: addValue("my:token", value).',
      );
    }
    const [token, value] = args;
    this.append(token, { kind: "value", useValue: value });
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
