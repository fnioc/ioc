// The registration builder. Holds the base token → registration list map and
// builds the ServiceProvider. Three registration surfaces:
//   - `add`        — a class (its ctor deps are injected),
//   - `addFactory` — a factory function (its call-param deps are injected),
//   - `addValue`   — an already-built instance (no deps, no lifetime).
// The transformer lowers the type-driven authoring forms (`add<I>(C)`,
// `add<I>(fn)`, `addValue<I>(v)`) to these; the explicit-token forms are the
// plugin-less mechanism for overrides, test doubles, and third-party wiring.
// `add<I>(fn)` (a factory) lowers to `addFactory("token", fn)` — the transformer
// statically knows the arg is a function, so the runtime never has to guess
// class-vs-factory.

import { isOpenToken, parseToken } from "@fnioc/core";
import type { DepSlot, Token } from "@fnioc/core";
import type { Func } from "@rhombus-toolkit/func";

import { OpenTokenRegistrationError } from "./errors.js";
import { ServiceProvider } from "./scope.js";
import type {
  ClassRegistration,
  Ctor,
  FactoryRegistration,
  Factory,
  OpenRegistration,
  Registration,
  Resolver,
} from "./types.js";

/** A token node that is exactly a hole: `$N`, decimal N ≥ 1. */
const HOLE_NODE = /^\$[1-9][0-9]*$/;

/**
 * Capitalize the first character of a string literal type, leaving the rest
 * untouched (`"request"` → `"Request"`). Used to mint a per-scope method name
 * `add${ProperCase<K>}` from a scope tag `K`. Because every scope tag is
 * guarded lowercase-first (`ValidScopes`), this map is INJECTIVE — two distinct
 * tags never collide on one minted name.
 */
export type ProperCase<T extends string> = T extends `${infer H}${infer R}`
  ? `${Uppercase<H>}${R}`
  : T;

/**
 * EMPTY carrier interface the `@fnioc/transformer` augments with the AUTHORED
 * single-arg call signatures for a per-scope `add${ProperCase<K>}` method
 * (`addRequest(C)` / `addRequest(fn)`). Like the other authoring forms, those
 * signatures are PURE TYPINGS contributed only when the transformer is in the
 * program — without it, a per-scope method exposes just the runtime two-arg
 * `(token, ctor) => void` shape. `S` is the full scope union, `K` the specific
 * scope this method tags with.
 */
export interface ScopeAddAuthoring<S extends string, K extends S> {}

/**
 * The per-scope registration methods minted from the scope union `S`. For each
 * tag `K`, a method named `add${ProperCase<K>}` whose runtime shape is
 * `(token, ctor) => void` (≡ `add(token, ctor).as(K)`), intersected with the
 * transformer-contributed `ScopeAddAuthoring<S, K>` authored single-arg forms.
 * The scope is baked into the name, so there is no `.as()` continuation — the
 * methods return `void`.
 */
export type ScopeAddMethods<S extends string> = {
  [K in S as `add${ProperCase<K>}`]: ((token: Token, ctor: Ctor) => void) &
    ScopeAddAuthoring<S, K>;
};

/**
 * The scope-union guard. A `ServiceManifest<S>` is only well-formed when every member
 * of `S` can mint a usable, non-colliding `add${ProperCase<K>}` method. `S`
 * resolves to itself when valid, else to `never` — which makes
 * `new ServiceManifest<S>()` a compile error at the construction site.
 *
 * Two rules, both checked NON-distributively (`[S] extends [...]`) so a union is
 * judged as a whole rather than member-by-member:
 *   - lowercase-first: every member must satisfy `K extends Uncapitalize<K>`.
 *     This makes `ProperCase` injective (no two tags collapse onto one method
 *     name) and keeps the transformer's uncapitalize-first scope recovery exact.
 *   - no collision: a member may not be `""` | `"factory"` | `"value"`, which
 *     would mint `add` / `addFactory` / `addValue` — the existing methods.
 */
export type ValidScopes<S extends string> = [S] extends [Uncapitalize<S>]
  ? [S & ("" | "factory" | "value")] extends [never]
    ? S
    : never
  : never;

/**
 * The continuation returned by a class `ServiceManifest.add`. Carries the just-added
 * registration so `.as()` can attach its lifetime in place. An `.add()` with no
 * trailing `.as()` leaves the registration scopeless ⇒ transient.
 *
 * `Scopes` is threaded so `.as()` only accepts a declared scope name —
 * compile-time guard at the registration site.
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
 * `Scopes` is the union of declarable scope names — the tags `.as()` and
 * `.createScope()` accept (default `"singleton"`). There is no root: scopes are
 * uniform tags, and `"singleton"` is just a tag you happen to open once at the
 * top. `"transient"` is NOT a member — transient is the absence of a scope, not
 * a scope. A registration whose tagged scope is not open at resolution time
 * resolves transiently (fresh instance, no cache).
 *
 * @example
 * ```ts
 * const services = new ServiceManifest<"singleton" | "request">();
 * services.add("pkg:ILogger", ConsoleLogger).as("singleton"); // lowered form
 * const provider = services.build();              // no frame pre-opened
 * const app = provider.createScope("singleton");  // open the singleton frame
 * const logger = app.resolve<ILogger>("pkg:ILogger");
 * const req = app.createScope("request");         // nested child scope
 * ```
 *
 * NOTE: this is the IMPLEMENTATION class. The public `ServiceManifest` value + type
 * (exported below) wrap it so the per-scope `add${ProperCase<K>}` methods —
 * which a class declaration cannot express as mapped members — surface on the
 * type. The class stays exported so the `@fnioc/transformer` `declare module`
 * augmentation can merge its authored typings onto `interface ServiceManifestClass`.
 */
export class ServiceManifestClass<Scopes extends string = "singleton"> {
  /**
   * The service collection: each token maps to a LIST of registrations in
   * registration order. Registering a token appends; resolution picks the
   * most-recent (last) registration. Earlier registrations are retained, which
   * is what lets a later `.add()` override an earlier one without deletion.
   */
  readonly #registrations = new Map<Token, Registration[]>();

  /**
   * The OPEN registration table: template base → open registrations in
   * registration order. Resolution matches against it on an exact-map miss
   * (base + arity + repeated-hole equality), most-recent match winning —
   * mirroring the exact map's last-wins list semantics.
   */
  readonly #openRegistrations = new Map<Token, OpenRegistration[]>();

  public constructor() {}

  /** Appends a registration to `token`'s list, creating the list on first use. */
  #append(token: Token, registration: Registration): void {
    const existing = this.#registrations.get(token);
    if (existing === undefined) {
      this.#registrations.set(token, [registration]);
    } else {
      existing.push(registration);
    }
  }

  /** Appends an open registration to `base`'s list, mirroring `#append`. */
  #appendOpen(base: Token, registration: OpenRegistration): void {
    const existing = this.#openRegistrations.get(base);
    if (existing === undefined) {
      this.#openRegistrations.set(base, [registration]);
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
  #appendScoped(
    token: Token,
    base: ClassRegistration | FactoryRegistration,
  ): AddBuilder<Scopes> {
    this.#append(token, base);
    const append = (next: Registration): void => this.#append(token, next);
    return {
      as<S extends Scopes>(scope?: S): void {
        // The lowered form always passes a value arg; the authored type-arg-only
        // form never executes (the transformer rewrites it first). A no-arg call
        // at runtime would leave the registration transient — guard so it is a
        // no-op rather than appending a scopeless duplicate.
        if (scope === undefined) {return;}
        append({ ...base, scope });
      },
    };
  }

  /**
   * Appends an OPEN class registration for a template token and returns the
   * `.as(scope?)` continuation — same scoped-copy semantics as `#appendScoped`,
   * against the open table. Enforces the v1 all-holes rule: every top-level
   * type argument of the service template must be exactly a hole (`$N`);
   * repeats (`IFoo<$<1>,$<1>>`) are allowed and constrain a match to equal args.
   */
  #appendOpenScoped(
    token: Token,
    ctor: Ctor,
    signatures: readonly (readonly DepSlot[])[] | undefined,
  ): AddBuilder<Scopes> {
    const parsed = parseToken(token);
    if (parsed === undefined || !parsed.args.every((arg) => HOLE_NODE.test(arg))) {
      throw new OpenTokenRegistrationError(token, "add");
    }
    const base: OpenRegistration = {
      template: token,
      base: parsed.base,
      pattern: parsed.args,
      ctor,
      scope: undefined,
      signatures,
    };
    this.#appendOpen(parsed.base, base);
    const append = (next: OpenRegistration): void => this.#appendOpen(parsed.base, next);
    return {
      as<S extends Scopes>(scope?: S): void {
        if (scope === undefined) {return;}
        append({ ...base, scope });
      },
    };
  }

  /**
   * Class registration — a string token bound to a concrete constructor. The
   * runtime form: what the transformer emits for a class, and what a
   * plugin-less caller writes directly. Returns the `.as(scope?)` continuation.
   *
   * The optional third `signatures` param carries the dep signatures ON the
   * registration record, where they win over the ctor-keyed `defineDeps` store
   * at resolve time. The scoping invariant behind that split: the global
   * `defineDeps` store holds CLASS-INTRINSIC facts — derivable from the
   * declaration alone, and so safely process-global. A generic impl's
   * signature-under-a-binding is instead REGISTRATION-INTRINSIC: the same JS
   * class closes differently per registration, so keying it on the ctor object
   * globally would merely relocate the collision cross-manifest. Carrying it on
   * the registration is the only key that scopes with the binding.
   *
   * An OPEN template token (`pkg:IRepo<$1>` — every type arg a hole) routes
   * into the open-registration table instead of the exact map; resolution
   * closes it per requested token. Mixing concrete args and holes in the
   * service token throws (v1 all-holes rule).
   */
  public add(
    token: Token,
    ctor: Ctor,
    signatures?: readonly (readonly DepSlot[])[],
  ): AddBuilder<Scopes>;
  public add(
    ...args:
      | [ctor: Ctor<any[], unknown>]
      | [factory: Func<any[], unknown>]
      | [token: Token, ctor: Ctor, signatures?: readonly (readonly DepSlot[])[]]
  ): AddBuilder<Scopes> {
    // Only the string-token forms reach the engine at runtime. The single-arg
    // authoring overloads never run post-transform; guard defensively so a
    // hand-written type-form call fails loud rather than registering junk.
    if (args.length === 1 || typeof args[0] !== "string") {
      throw new TypeError(
        "add<I>(ctor) / add<I>(factory) require the @fnioc/transformer plugin. " +
          'Without it, register with an explicit token: add("my:token", MyClass) ' +
          "or addFactory(\"my:token\", (scope) => ...).",
      );
    }
    const [token, ctor, signatures] = args;
    if (isOpenToken(token)) {
      return this.#appendOpenScoped(token, ctor as Ctor, signatures);
    }
    return this.#appendScoped(token, {
      kind: "class",
      ctor: ctor as Ctor,
      scope: undefined,
      signatures,
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
  ): AddBuilder<Scopes>;
  public addFactory(
    token: Token,
    factory: Factory,
  ): AddBuilder<Scopes> {
    // Open registrations are class-only: a template must synthesize per-closing
    // class registrations, which a factory/value shape cannot express in v1.
    if (isOpenToken(token)) {
      throw new OpenTokenRegistrationError(token, "addFactory");
    }
    return this.#appendScoped(token, {
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
    if (isOpenToken(token)) {
      throw new OpenTokenRegistrationError(token, "addValue");
    }
    this.#append(token, { kind: "value", useValue: value });
  }

  /**
   * Builds the ServiceProvider with a SEALED copy of the registration map.
   * Sealing (deep-freezing the map and each per-token list) ensures that any
   * `.add()` call on the builder after `build()` cannot mutate what the
   * provider and its descendants see — the container's view is fixed at
   * construction time.
   *
   * NO frame is pre-opened: the returned provider is frameless. There is no
   * root scope — resolving a tagged registration with no matching frame open
   * yields a transient instance, and an untagged registration is transient as
   * always. Open a scope explicitly with `createScope(name)` when you want a
   * tagged registration to cache.
   */
  public build(): ServiceProvider<Scopes> {
    // Deep-copy the registrations so post-build builder mutations can't affect
    // the sealed map. Each per-token list is frozen independently.
    const sealed = new Map<Token, Registration[]>();
    for (const [token, list] of this.#registrations) {
      sealed.set(token, Object.freeze([...list]) as Registration[]);
    }
    Object.freeze(sealed);

    // The open table is sealed the same way. The closed-registration memo is
    // deliberately MUTABLE and starts empty: registrations synthesized from
    // open matches land there (never in the sealed maps), and it is created
    // here — not per provider — so every scope frame of this provider tree
    // shares one memo.
    const sealedOpen = new Map<Token, OpenRegistration[]>();
    for (const [base, list] of this.#openRegistrations) {
      sealedOpen.set(base, Object.freeze([...list]) as OpenRegistration[]);
    }
    Object.freeze(sealedOpen);

    return new ServiceProvider<Scopes>(
      sealed as ReadonlyMap<Token, Registration[]>,
      sealedOpen as ReadonlyMap<Token, readonly OpenRegistration[]>,
      new Map<Token, Registration>(),
    );
  }
}

/**
 * Install the per-scope `add${ProperCase<K>}` runtime dispatch ONCE at module
 * load, at the END of `ServiceManifestClass`'s prototype chain. A `Proxy` placed there
 * (its target is `Object.prototype`, the chain's real terminus) only ever sees a
 * `get`/`has` that MISSED the class's own prototype — so `add`, `addFactory`,
 * `addValue`, `build`, and any inherited `Object.prototype` member are untouched.
 * Only a genuinely-absent `add<Capital…>` lookup reaches the trap.
 *
 * Receiver fidelity: the `get` trap's `receiver` and the returned method's `this`
 * are the genuine `ServiceManifestClass` instance (not the proxy), so `#private` fields
 * resolve with zero gymnastics — the method just calls `this.add(...)`.
 */
const SCOPE_ADD = /^add[A-Z]/;

Reflect.setPrototypeOf(
  ServiceManifestClass.prototype,
  new Proxy(Object.prototype, {
    get(_target, prop, receiver) {
      if (typeof prop === "string" && SCOPE_ADD.test(prop)) {
        const scope = prop[3]!.toLowerCase() + prop.slice(4);
        return function (this: ServiceManifestClass<string>, ...args: unknown[]): void {
          // Mirror `add()`'s guard: only the `(token, ctor)` / `(token, ctor,
          // signatures)` runtime forms execute. A single-arg authored call
          // (`addRequest(C)`) only exists post-transform; hand-writing it
          // without @fnioc/transformer is a misuse.
          if (
            (args.length !== 2 && args.length !== 3) ||
            typeof args[0] !== "string"
          ) {
            throw new TypeError(
              `${prop}<I>(ctor) / ${prop}<I>(factory) require the @fnioc/transformer ` +
                `plugin. Without it, register with an explicit token: ` +
                `${prop}("my:token", MyClass).`,
            );
          }
          this.add(
            args[0],
            args[1] as Ctor,
            args[2] as readonly (readonly DepSlot[])[] | undefined,
          ).as(scope);
        };
      }
      return Reflect.get(Object.prototype, prop, receiver);
    },
    has(_target, prop) {
      return (
        (typeof prop === "string" && SCOPE_ADD.test(prop)) ||
        Reflect.has(Object.prototype, prop)
      );
    },
  }),
);

/**
 * The public registration-builder TYPE: the implementation class intersected
 * with the per-scope methods minted from `S`. A type alias (not an interface)
 * because an interface cannot extend a generic MAPPED type, and `ScopeAddMethods`
 * is one.
 */
export type ServiceManifest<S extends string = "singleton"> = ServiceManifestClass<S> &
  ScopeAddMethods<S>;

/**
 * A construction-site guard parameter that carries the `ValidScopes` verdict.
 * When `S` is a valid scope union, `ValidScopes<S>` resolves to `S` (not
 * `never`), so the guard is an EMPTY rest tuple — `new ServiceManifest<S>()` takes no
 * args. When `S` is invalid, `ValidScopes<S>` collapses to `never`, and the
 * guard becomes a REQUIRED arg whose name spells out the error, so the no-arg
 * `new ServiceManifest<S>()` fails to type-check at the construction site.
 *
 * This expresses the same intent as a self-referential `S extends ValidScopes<S>`
 * constraint, which TypeScript rejects as circular (TS2313) and which silently
 * stops validating — the guard-param form is the working equivalent.
 */
export type ScopeGuard<S extends string> = [ValidScopes<S>] extends [never]
  ? [
      error: "invalid ServiceManifest scope tag: every member must be lowercase-first and not \"\" / \"factory\" / \"value\"",
    ]
  : [];

/**
 * The static / constructor side of the public `ServiceManifest`. Extracted as an
 * interface so the value export can carry the `ValidScopes` guard on its type
 * parameter: `new ServiceManifest<S>()` only type-checks when `S` is a valid scope
 * union (lowercase-first, no collision with `add`/`addFactory`/`addValue`).
 */
export interface ServiceManifestCtor {
  new <S extends string = "singleton">(...guard: ScopeGuard<S>): ServiceManifest<S>;
}

/**
 * The public registration-builder VALUE. It IS `ServiceManifestClass` at runtime (the
 * cast only re-types its construct signature to carry the `ValidScopes` guard
 * and the per-scope method surface). `new ServiceManifest<...>()` behaves identically;
 * the wrapper exists purely so the mapped per-scope methods type-check.
 */
export const ServiceManifest: ServiceManifestCtor = ServiceManifestClass as unknown as ServiceManifestCtor;
