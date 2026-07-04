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

import type { DepSlot, Token } from "@fnioc/core";
import type {
  AddBuilder,
  ScopeAddMethods,
  ScopeGuard,
  ServiceManifestBase,
} from "@fnioc/core";
import type { Func } from "@rhombus-toolkit/func";

import { OpenTokenRegistrationError } from "./errors.js";
import { ServiceProvider } from "./scope.js";
import { HOLE_PATTERN, isOpenToken, parseToken } from "./tokens.js";
import type {
  ClassRegistration,
  Ctor,
  FactoryRegistration,
  Factory,
  OpenRegistration,
  Registration,
  Resolver,
} from "./types.js";

// The authoring TYPE-machinery — `ProperCase`, `ScopeAddAuthoring`,
// `ScopeAddMethods`, `ValidScopes`, `AddBuilder`, `ScopeGuard`, the collection
// interface `ServiceManifestBase`, and the `ServiceManifest`/`ServiceManifestCtor`
// shapes — lives in the pure-types `@fnioc/core` package (the abstractions surface
// a library author depends on). di imports it back via `import type` and its
// runtime `ServiceManifestClass` implements the interface.

/** Appends `value` to the list at `key`, creating the list on first use. */
function appendTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, [value]);
  } else {
    existing.push(value);
  }
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
export class ServiceManifestClass<Scopes extends string = "singleton">
  implements ServiceManifestBase<Scopes, ServiceProvider<Scopes>>
{
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
    appendTo(this.#registrations, token, registration);
  }

  /** Appends an open registration to `base`'s list, mirroring `#append`. */
  #appendOpen(base: Token, registration: OpenRegistration): void {
    appendTo(this.#openRegistrations, base, registration);
  }

  /**
   * Builds the `.as(scope?)` continuation over an `appendScoped` callback that
   * appends a fresh scoped copy for the chosen tag. Shared by the class and open
   * registration paths — both append a base (transient) registration first, then
   * hand back this continuation so a trailing `.as(scope)` appends the winning
   * scoped copy.
   */
  #scopedContinuation(appendScoped: (scope: Scopes) => void): AddBuilder<Scopes> {
    return {
      as<S extends Scopes>(scope?: S): void {
        // The lowered form always passes a value arg; the authored type-arg-only
        // form never executes (the transformer rewrites it first). A no-arg call
        // at runtime would leave the registration transient — guard so it is a
        // no-op rather than appending a scopeless duplicate.
        if (scope === undefined) {return;}
        appendScoped(scope);
      },
    };
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
    return this.#scopedContinuation((scope) =>
      this.#append(token, { ...base, scope }),
    );
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
    if (parsed === undefined || !parsed.args.every((arg) => HOLE_PATTERN.test(arg))) {
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
    return this.#scopedContinuation((scope) =>
      this.#appendOpen(parsed.base, { ...base, scope }),
    );
  }

  /**
   * Class registration — a string token bound to a concrete constructor. The
   * runtime form: what the transformer emits for a class, and what a
   * plugin-less caller writes directly. Returns the `.as(scope?)` continuation.
   *
   * The optional third `signatures` param carries the dep signatures ON the
   * registration record — the sole signature channel now that the global
   * metadata store is retired. The transformer emits it inline for every
   * constructed class (`add(token, ctor, [[...]])`); a plugin-less caller
   * hand-feeds it directly. Keying signatures on the registration (not on the
   * ctor object) is what lets one JS class close differently per registration —
   * an open template and its closings never collide.
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
      | [ctor: Ctor<any[], unknown>, overrides: readonly (string | undefined)[]]
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
   * runtime form the transformer emits for an authored `add<I>(fn)` /
   * `addFactory<I>(fn)`, and what a plugin-less caller writes directly.
   *
   * Parameter injection follows the metadata rule (see `ServiceProvider`): a
   * factory WITH registration-carried signatures (the optional third arg, emitted
   * inline by the transformer) has each parameter injected by its slot; a
   * signature-less factory (the plugin-less escape hatch) is called with the live
   * provider — type it `(sp: Resolver) => T` and `sp.resolve(...)` its own deps.
   * Returns the `.as(scope?)` continuation so a factory caches at a named scope
   * exactly like a class.
   *
   * The implementation signature admits the single-arg authoring form
   * (`addFactory<I>(fn)`) so the `@fnioc/transformer` overload merges onto it —
   * that form never runs post-transform, and the runtime guard below fails a
   * plugin-less call loud rather than registering junk (mirrors `add`).
   */
  public addFactory(
    token: Token,
    factory: Func<[Resolver], unknown>,
    signatures?: readonly (readonly DepSlot[])[],
  ): AddBuilder<Scopes>;
  public addFactory(
    ...args:
      | [factory: Func<any[], unknown>]
      | [token: Token, factory: Factory, signatures?: readonly (readonly DepSlot[])[]]
  ): AddBuilder<Scopes> {
    // Only the string-token form reaches the engine at runtime. The single-arg
    // `addFactory<I>(fn)` authoring overload never runs post-transform; guard
    // defensively so a hand-written type-form call fails loud.
    if (args.length === 1 || typeof args[0] !== "string") {
      throw new TypeError(
        "addFactory<I>(fn) requires the @fnioc/transformer plugin. Without it, " +
          'register with an explicit token: addFactory("my:token", (scope) => ...).',
      );
    }
    const [token, factory, signatures] = args;
    // Open registrations are class-only: a template must synthesize per-closing
    // class registrations, which a factory/value shape cannot express in v1.
    if (isOpenToken(token)) {
      throw new OpenTokenRegistrationError(token, "addFactory");
    }
    return this.#appendScoped(token, {
      kind: "factory",
      factory,
      scope: undefined,
      signatures,
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
 * The public registration-builder TYPE for di consumers: the implementation
 * class intersected with the per-scope methods minted from `S`. A type alias
 * (not an interface) because an interface cannot extend a generic MAPPED type,
 * and `ScopeAddMethods` is one.
 *
 * The `ServiceManifestClass<S>` arm (not core's `ServiceManifestBase`) is
 * deliberate: it carries di's concrete `build(): ServiceProvider<S>` AND is the
 * interface the `@fnioc/transformer` augmentation merges its authored `add<I>()`
 * forms onto, so the alias picks those up through this arm. `ScopeAddMethods`
 * comes from the pure-types `@fnioc/core`. (core's own `ServiceManifest` alias is
 * the provider-agnostic LIBRARY-AUTHOR view — no di class, no transformer forms.)
 */
export type ServiceManifest<S extends string = "singleton"> = ServiceManifestClass<S> &
  ScopeAddMethods<S>;

/**
 * The static / constructor side of the public `ServiceManifest`. Extracted as an
 * interface so the value export can carry the `ValidScopes` guard on its type
 * parameter: `new ServiceManifest<S>()` only type-checks when `S` is a valid scope
 * union (lowercase-first, no collision with `add`/`addFactory`/`addValue`). It
 * returns di's provider-bound `ServiceManifest<S>`.
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
