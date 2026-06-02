// The registration builder. Holds the base token → registration list map and
// mints the root ServiceProvider. Three registration surfaces:
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
import type { Func } from "@rhombus-toolkit/func";

import { Scope, ServiceProvider } from "./scope.js";
import type {
  ClassRegistration,
  Ctor,
  FactoryRegistration,
  Factory,
  Registration,
  Resolver,
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
   * Attaches the lifetime — the RUNTIME (lowered) form. Must name a declared
   * scope.
   *
   * `.as("singleton")` is what the engine executes: the transformer rewrites the
   * authored type-arg form (`.as<"singleton">()`) to this value-arg form before
   * runtime, and a plugin-less caller writes it directly. The AUTHORED type-arg
   * form (`.as<S extends Scopes>(): void`) is a PURE TYPING contributed by the
   * `@fnioc/transformer` augmentation — it is not part of di's published surface,
   * so it only type-checks when the transformer's types are in the program.
   */
  as(scope: Scopes): void;
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
   * Class registration — a string token bound to a concrete constructor. The
   * runtime form: what the transformer emits for a class, and what a
   * plugin-less caller writes directly. Returns the `.as(scope?)` continuation.
   */
  public add(token: Token, ctor: Ctor): AddBuilder<Root | Children>;
  public add(
    ...args:
      | [ctor: Ctor<any[], unknown>]
      | [factory: Func<any[], unknown>]
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
   * Parameter injection follows the metadata rule (see `ServiceProvider`): a
   * factory WITH a `defineDeps` record (emitted by the transformer) has each
   * parameter injected by its slot; a record-less factory (the plugin-less
   * escape hatch) is called with the live provider — type it `(sp: Resolver)
   * => T` and `sp.resolve(...)` its own deps. Returns the `.as(scope?)`
   * continuation so a factory caches at a named scope exactly like a class.
   */
  public addFactory(
    token: Token,
    factory: Func<[Resolver], unknown>,
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
   * overload. The authoring form `addValue<I>(v)` (which lowers to
   * `addValue("token", v)`) is a PURE TYPING contributed by the
   * `@fnioc/transformer` augmentation, not part of di's published surface.
   */
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
   * Mints the root ServiceProvider with a SEALED copy of the registration map.
   * Sealing (deep-freezing the map and each per-token list) ensures that any
   * `.add()` call on the builder after `build()` cannot mutate what the root
   * and its descendants see — the container's view is fixed at construction time.
   */
  public build(): ServiceProvider<Root | Children> {
    // Deep-copy the registrations so post-build builder mutations can't affect
    // the sealed map. Each per-token list is frozen independently.
    const sealed = new Map<Token, Registration[]>();
    for (const [token, list] of this.registrations) {
      sealed.set(token, Object.freeze([...list]) as Registration[]);
    }
    Object.freeze(sealed);

    const rootFrame = new Scope(this.rootName as string);
    return new ServiceProvider<Root | Children>(
      sealed as ReadonlyMap<Token, Registration[]>,
      rootFrame,
    );
  }
}
