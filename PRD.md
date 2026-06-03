# `ioc` — Type-Driven, Interface-First Dependency Injection for TypeScript

> **Status:** Design locked — implementation in progress
> **Date:** 2026-05-30
> **GitHub:** `fnioc/ioc` | **npm scope:** `@fnioc`

---

## 1. Overview

`ioc` is an interface-driven, attribute-free dependency injection system for TypeScript built on a single organizing idea: **lowering**. The same relationship holds between `@fnioc` authoring and the emitted runtime calls as holds between JSX and `createElement`, or between TypeScript and JavaScript. You author against rich, fully type-checked, interface-based DI; the compile-time transformer lowers that into plain runtime registration calls carrying explicit string tokens and positional dep arrays. The runtime engine consumes those plain calls and never touches a TypeScript type.

The payoff is the **portable substrate**: because the lowered form is just ordinary JavaScript, a library author compiles with the transformer once and publishes the lowered output. Every consumer — whether or not they have the transformer configured — installs the library and its registrations run as-is. The transformer is sugar over a substrate that is always usable by hand.

No decorators by default. No `reflect-metadata`. No runtime type introspection. Registrations are keyed against interfaces, not concrete classes.

```
Author code (type-driven)                   Compiled output (plain data)              Runtime
─────────────────────────                   ────────────────────────────              ───────
const services =                            const services = new DiBuilder();
  new DiBuilder<"singleton">();
                                            defineDeps(ConsoleLogger, []);
services.add<ILogger>(ConsoleLogger)  ──►   services.add("pkg:ILogger",         ──►   DI engine
  .as<"singleton">();                           ConsoleLogger).as("singleton");        resolves graph

           ▲                                           ▲
    @fnioc/transformer                           @fnioc/di
  (ts-patch, build time)                    (runtime engine, ~400 LOC)
```

The transformer is the hard 80%. The engine is small because it never sees types — it works purely on the emitted plain-data tokens and dep arrays.

---

## 2. Goals & Non-Goals

### Goals

- **Interface-driven registration.** Tokens are derived from interface types at compile time; the container never inspects a class's prototype chain for type information.
- **No decorators by default.** The transformer handles annotation automatically. The `@signature` decorator and `forCtor` fluent API exist for hand-annotation only (classes you don't own, manual overrides).
- **No runtime reflection.** No `reflect-metadata`, no `emitDecoratorMetadata`, no `design:paramtypes`. The transformer supplies precise data once at build time.
- **Progressive enhancement.** The engine is fully usable hand-fed. The transformer is an enhancement that automates token generation, dep extraction, and emit — not a prerequisite.
- **Library-publishable.** A library compiled with the transformer publishes plain-data registrations that any consumer can use without having the transformer configured.
- **Correct scope semantics.** Captive-dependency misconfiguration fails loudly at resolve time, not silently at runtime much later.
- **Native disposal.** Uses TC39 `Disposable` / `AsyncDisposable` (`Symbol.dispose` / `Symbol.asyncDispose`, `using` / `await using`, TypeScript 5.2+).
- **One resolution channel.** Async is expressed as values (`Promise<T>`) through the sync channel — the container never awaits anything.

### Non-Goals

- Runtime decorator scanning (`emitDecoratorMetadata`, `reflect-metadata`) — explicitly rejected.
- A separate async resolution channel or `resolveAsync()` API — async is values; one channel.
- Auto-creating missing ancestor scopes — missing tag ancestor always throws.
- `static $inject` as a v1 authoring surface — deferred; reintroduces prototype-bleed the WeakMap design prevents.
- Wessberg-style two-type-param `add<IFoo, Foo>()` with ctor inferred from generic — deferred (TS partial type-argument inference blocker).
- By-name dep matching — deferred.
- A separate `@fnioc/abi` package — `@fnioc/core` *is* the ABI.

---

## 3. Glossary / Core Concepts

| Term | Definition |
|---|---|
| **Token** | A stable `string` identifying a type. The DI key. Derived by the transformer from a TypeScript type name. Every named type tokenizes: `string` → `"string"`, `IFoo` → `"pkg:IFoo"`, `boolean` → `"boolean"`, etc. Only anonymous inline structures (object literal types, nameless non-intrinsics) are non-tokenizable and produce a compile error. |
| **LiteralRef** | A `{ value }` slot, emitted when a constructor/factory parameter (or `resolve<T>()` type argument) is a **singular** (non-union) literal type (`"dev"`, `42`, `true`, `1n`) or a nullish singleton (`void`/`undefined` → `undefined`, `null` → `null`). At resolve time the value is injected directly — no container lookup; always satisfiable. `value` may be `undefined`, so the slot is identified by the *presence* of the `value` key. Literal unions (`"a"\|"b"`) are NOT `LiteralRef`; they derive a single sorted token and resolve through the container. |
| **Union slot** | A `{ union: [...] }` slot — member-level alternatives tried in declaration order; the first resolvable member wins, and a member that resolves but throws (e.g. a captive `MissingScopeError`) falls through to the next. Satisfiable iff at least one member is. Used for inline union parameter types (`A \| B`) and as the lowering of an **optional** parameter: `x?: X` → `union(X, { value: undefined })` with the always-satisfiable `LiteralRef` fallback last. |
| **Signature** | A positional array of `DepSlot` values parallel to a constructor's parameter list. `signature[i]` describes how to satisfy constructor parameter `i`: a `string` token resolved from the container, a `LiteralRef` injected directly, a `FactoryRef`, a `ScopeRef`, or a `Union` of alternatives. The word "signature" is used consistently in the ABI field name, the `@signature` decorator, and the `forCtor(...).signature(...)` fluent API. |
| **DepRecord** | `{ abi: number, signatures: ReadonlyArray<ReadonlyArray<DepSlot>> }` — the per-constructor metadata stored in the global WeakMap. Multi-signature from v1 to support constructor overloads without an ABI break. |
| **Scope** | A node in a parent-linked chain that owns and caches instances. Scope names are a user-defined string union passed to `DiBuilder<Scopes>`. |
| **Lifetime tag** | The scope name a registration is bound to. Determines which ancestor scope caches the instance. A registration with no tag is transient. |
| **Transient** | A registration with no lifetime tag. Fresh instance on every resolve; never cached. Conceptually an ephemeral throwaway scope — the engine just skips the cache. |
| **ABI\_VERSION** | An exported integer constant (currently `1`). Coarse runtime-compatibility guard for the global WeakMap key. Only bumped on an actual wire-format break — rarer than a `core` semver major. |

---

## 4. Package Architecture

Three packages in v1. Dependency graph: `core` ← `di`, `core` ← `transformer`. **`di` and `transformer` do not depend on each other.** This separation is structural: the transformer is build-time only and shares only the ABI/token format; `di` can be developed, tested, and hand-fed with no plugin installed.

```
@fnioc/core          @fnioc/di           @fnioc/transformer
────────────         ─────────           ──────────────────
Token type           DiBuilder           ts-patch transformer
DepSlot types        Scope chain         Token generation
DepRecord shape      Registration API    Dep extraction
ABI_VERSION          Resolution engine   defineDeps emission
defineDeps()         Disposal            Registration lowering
@signature           Cycle detection     §4.5 factory diagnostic
forCtor()            Factory injection
                     useFactory/useValue
```

### Package contents

| Package | Responsibility | Depends on |
|---|---|---|
| `@fnioc/core` | Immutable substrate: ABI types, global WeakMap, `defineDeps`, `@signature`, `forCtor` | — |
| `@fnioc/di` | Runtime engine: resolution, scoping, lifecycle, disposal, factories | `@fnioc/core` |
| `@fnioc/transformer` | Build-time ts-patch plugin: token gen, dep extraction, lowered output emission | `@fnioc/core` (ABI/token format only) |

`@fnioc/di` may re-export `@signature` and `forCtor` from `@fnioc/core` for single-import ergonomics. Authoring surfaces live in `core` because they are pure metadata writers with zero resolution dependency.

### Future stubs (not v1)

`@fnioc/eslint-plugin` (surface the §4.5 factory diagnostic in-editor), an `unplugin` wrapper (Vite/Rollup/esbuild/webpack), testing utilities.

---

## 5. The ABI (`@fnioc/core`)

`@fnioc/core` is the ABI. There is no separate `@fnioc/abi` package — the ABI types and the WeakMap/`defineDeps` that read and write them are one intrinsic unit; splitting them buys no decoupling.

### DepRecord shape

```typescript
export type Token = string;

/**
 * Supplies its value directly — no container lookup. Emitted for a singular
 * (non-union) literal (`"dev"`, `42`, `true`, `1n`) and for the nullish
 * singletons `void`/`undefined` (→ `undefined`) and `null` (→ `null`). `value`
 * may itself be `undefined`, so a `LiteralRef` is identified by the PRESENCE of
 * the `value` key, never by `value !== undefined`. Always satisfiable.
 */
export interface LiteralRef {
  readonly value: string | number | boolean | bigint | undefined | null;
}

/** Member-level alternatives tried in declaration order; first resolvable wins. */
export interface Union { readonly union: ReadonlyArray<DepSlot>; }

/**
 * One slot in a signature:
 *   string      — token resolved from the container (may be unregistered at runtime)
 *   LiteralRef  — singular literal / nullish singleton; value injected directly, no lookup
 *   FactoryRef  — factory-injection slot (produced by the transformer for arrow/function params)
 *   ScopeRef    — injects the owning Scope object
 *   Union       — alternatives tried in order; satisfiable iff one member is
 */
export type DepSlot = Token | LiteralRef | FactoryRef | ScopeRef | Union;

export interface DepRecord {
  readonly abi: number;
  readonly signatures: ReadonlyArray<ReadonlyArray<DepSlot>>;
}

export const ABI_VERSION = 1;
```

`signatures` is an array of arrays from v1. Multiple signatures support **manual** constructor overloads (`@signature` stacking, `forCtor` chaining) and **declared** ctor overloads (one signature per bodyless declaration). Auto-extraction from an implementation constructor always emits exactly one signature — optionality is expressed *within* a signature via a `Union` slot, not by emitting extra shorter signatures.

### Global-symbol WeakMap hardening

The WeakMap is anchored on `globalThis` under a version-suffixed `Symbol.for` key:

```typescript
const KEY = Symbol.for(`@fnioc/core:deps@${ABI_VERSION}`);
// Using Symbol.for (never Symbol()) — the registry is global, so two bundles
// with the same ABI_VERSION share the same key and thus the same WeakMap.
const deps: WeakMap<Function, DepRecord> =
  (globalThis as any)[KEY] ??= new WeakMap();
```

**Why `Symbol.for` and never `Symbol()`:** a unique symbol would fragment the map between two copies of `core` loaded into the same runtime (the dual-package hazard). `Symbol.for` entries are global-registry entries; two copies of the same `@fnioc/core@N` loading in the same process will find the same symbol and the same WeakMap.

**What is (and is not) globalized:** only the immutable, app-agnostic dep-metadata (the `DepRecord` entries keyed by constructor function). The container/registry is per-instance — globalizing it would break multi-tenant SSR and multiple-container scenarios.

**ABI version isolation:** different `ABI_VERSION` integers produce different `Symbol.for` keys and therefore different WeakMaps. They remain isolated by design. A v1 `core` and a hypothetical v2 `core` coexist cleanly.

### `defineDeps` — the single shared writer

```typescript
export function defineDeps(
  ctor: Function,
  signatures: ReadonlyArray<ReadonlyArray<DepSlot>>,
): void {
  const existing = deps.get(ctor);
  if (existing) {
    // Merge: append unique signatures (for stacking @signature calls)
    const merged = [...existing.signatures];
    for (const sig of signatures) {
      if (!merged.some(s => arraysEqual(s, sig))) {
        merged.push(sig);
      }
    }
    deps.set(ctor, { abi: ABI_VERSION, signatures: merged });
  } else {
    deps.set(ctor, { abi: ABI_VERSION, signatures });
  }
}
```

`defineDeps` is the single write path. Both the transformer-emitted code and `@signature`/`forCtor` funnel through it. No other code writes to the WeakMap.

### Versioning policy

Each package is versioned independently via release-please (semver). `ABI_VERSION` is a separate, coarse integer bumped only on an actual wire-format break — it is not tied to `@fnioc/core`'s semver major. The combination gives fine-grained package versioning for bugfixes and new features, and a blunt compatibility guard for the rare cases that break the dep-metadata wire format.

**Dual-package hazard:** if two copies of `@fnioc/core` at the same `ABI_VERSION` end up in the same bundle (e.g. a deduplication failure), the `Symbol.for` hardening means they share one WeakMap — data written through either copy is visible to both. If the copies have different `ABI_VERSION` values, they are isolated, which is the correct behavior (different wire formats should not mix). The remaining residual risk is two copies at the same ABI but different *content* — a corner case that the hardening doesn't fully close, mitigated by declaring `@fnioc/core` a peer dependency.

---

## 6. Authoring Surfaces

Both surfaces live in `@fnioc/core` and call `defineDeps` internally. They exist for manual annotation — for classes the transformer cannot reach (third-party, dynamically-registered, or in a plugin-less workflow).

### `@signature` — TC39 class decorator

```typescript
export function signature(...slots: ReadonlyArray<DepSlot>) {
  return function (ctor: Function, _ctx: ClassDecoratorContext): void {
    defineDeps(ctor, [[...slots]]);
  };
}
```

**Stacking decorators = multiple overloads.** TypeScript evaluates decorators bottom-up, so each `@signature` call appends one signature to the DepRecord.

```typescript
// Two overloads: one with a logger, one without
@signature("pkg:ILogger", "pkg:IDb")
@signature("pkg:IDb")
class MyService {
  constructor(logOrDb: ILogger | IDb, db?: IDb) { ... }
}
```

### `forCtor` — fluent free-function

```typescript
export function forCtor(ctor: Function): ForCtorBuilder {
  return {
    signature(...slots: ReadonlyArray<DepSlot>): ForCtorBuilder {
      defineDeps(ctor, [[...slots]]);
      return this; // chaining = additional overloads
    },
  };
}
```

For classes you don't own or when you prefer not to decorate:

```typescript
// Third-party class; annotate without touching its source
forCtor(ThirdPartyService)
  .signature("pkg:IDb")
  .signature("pkg:ILogger", "pkg:IDb"); // second overload
```

The verb `signature` is used consistently: the ABI field is `signatures`, the decorator is `@signature`, and the fluent method is `.signature()`. One word, one concept, end to end.

### Token derivation for named types

Every named type produces a token by its name. No special-casing for intrinsics:

| Parameter type | Token emitted |
|---|---|
| `IFoo` (package-public) | `"pkg:IFoo"` |
| `IBar` (app-internal) | `"./src/IBar"` |
| `string` | `"string"` |
| `number` | `"number"` |
| `boolean` | `"boolean"` |
| `symbol` | `"symbol"` |
| `bigint` | `"bigint"` |
| `any` | `"any"` |
| `unknown` | `"unknown"` |
| `never` | `"never"` |

`void`, `undefined`, and `null` are **not** in this table — each is a *singleton* type (exactly one inhabitant), so it is supplied directly as a `LiteralRef` (next section), never tokenized. `never` (zero inhabitants — nothing to supply) is tokenized to `"never"` and simply misses at runtime. Wide `boolean` (TypeScript models it as the union `false | true`) special-cases here to the bare token `"boolean"`, not a literal union.

An unregistered token (including the above intrinsic tokens if nothing is registered for them) causes an `UnregisteredTokenError` at resolve time. That is the expected, intended behavior — it is not a compile error. If a parameter can never be satisfied from the container, make it optional (so it lowers to a `union(..., { value: undefined })` fallback — see below) or use `addFactory` and supply it at call time.

**The only compile error is a non-tokenizable type.** Anonymous inline structures — object literal types and nameless non-intrinsics — cannot produce a stable token. The transformer emits diagnostic `990006` (`UnderivableToken`) for these. The fix is to name the type (`interface Opts { ... }`) or use `Inject<T, "explicit-token">` as the explicit escape hatch.

### Singular literal & nullish-singleton types → `LiteralRef` (direct value supply)

When a constructor or factory parameter's type is a **singular** (non-union) literal — `"dev"`, `42`, `true`, `1n` — the transformer emits a `LiteralRef { value }` slot instead of a token. At resolve time the value is injected directly; the container is not consulted. Always satisfiable — the value is self-supplying, so a `LiteralRef` slot never makes a signature unresolvable.

The nullish singletons are also `LiteralRef`s: a whole-type `void` or `undefined` parameter supplies `undefined`; a whole-type `null` parameter supplies `null`. (`value` may itself be `undefined`, so the slot is identified by the *presence* of the `value` key — see `isLiteralRef`.) `LiteralRef.value` therefore spans `string | number | boolean | bigint | undefined | null`. Negative numbers and bigints round-trip (`-7`, `-3n`).

```typescript
@signature("pkg:ILogger", { value: "dev" }, "pkg:IDb")
class DevLogger {
  constructor(log: ILogger, env: "dev", db: IDb) { ... }
  // env is supplied as the literal "dev" — no registration needed
}
```

**`resolve<T>()` for a singular `T` lowers to the value expression itself**, not to a `resolve` call — there is no container round-trip:

```typescript
scope.resolve<"dev">()   // lowers to:  "dev"
scope.resolve<42>()      // lowers to:  42
scope.resolve<1n>()      // lowers to:  1n
scope.resolve<void>()    // lowers to:  void 0
scope.resolve<undefined>() // lowers to: void 0
scope.resolve<null>()    // lowers to:  null
```

A **literal union** (`"a" | "b"`) is different: it derives a single sorted token whose members are JSON-quoted and joined with ` | ` (so `"a" | "b"`, and `2 | 1` → `"1 | 2"`), and resolves through the container as a normal registration — never per-member `LiteralRef`s. `resolve<"a" | "b">()` therefore stays `scope.resolve("\"a\" | \"b\"")`. `LiteralRef` applies only to singular literals and nullish singletons.

**Registration side unchanged.** `add`, `addValue`, `addFactory`, and `nameof` are not affected by `LiteralRef`. Literal-typed parameters simply never need a registration entry.

### Optional/defaulted/`T | undefined` params → union-with-fallback (one signature)

Optionality is unified on the `Union` slot — there is **no overload expansion**. A parameter that is optional in *any* form, at *any* position — `x?: X`, `x: X = default`, `x: X | undefined`, `x: X | void` — lowers to a single `union(<non-nullish slots>, { value: undefined })` slot with the `LiteralRef` fallback **last**. Auto-extraction from an implementation constructor emits exactly ONE signature.

At resolve time the union tries members in declaration order: the real dependency `X` wins when it is registered; otherwise the always-satisfiable `{ value: undefined }` member supplies `undefined`, and for a defaulted parameter JS treats an explicit `undefined` argument as omission, so the default initializer fires. Because the fallback is always satisfiable, an optional parameter never throws `NoSatisfiableSignatureError`.

```typescript
constructor(dep?: IFoo)                  // → [ union("pkg:IFoo", { value: undefined }) ]
constructor(a: IFoo, p: string = "x")    // → [ "pkg:IFoo", union("string", { value: undefined }) ]
constructor(a: IFoo | undefined, b: IBar)// → [ union("pkg:IFoo", { value: undefined }), "pkg:IBar" ]
constructor(dep?: IFoo | IBar)           // → [ union("pkg:IFoo", "pkg:IBar", { value: undefined }) ]
```

`x: X | null` is *not* optionality — `null` is a real value, not the optionality marker — so it lowers to `union(X, { value: null })` (the `null` member is a genuine alternative). An optional pure-literal union keeps its single sorted literal token as the non-nullish part: `mode?: "a" | "b"` → `union("\"a\" | \"b\"", { value: undefined })`.

This is strictly more expressive than trailing-overload expansion: it can represent `(a: X | undefined, b: Y)` where the *interior* param is optional — overload-dropping could only drop trailing params and would lose `b`, whereas the per-param union yields `new Ctor(undefined, y)`. A genuinely required, never-registered parameter still resolves to a bare token that misses at runtime (`UnregisteredTokenError`); the fix is to register the dep, make the parameter optional, or build the class via `addFactory`.

### Canonical authoring → lowered example

**Author code (with transformer):**

```typescript
const services = new DiBuilder<"singleton" | "request">();

services.add<ILogger>(ConsoleLogger).as<"singleton">();
services.add<IUserRepo>(SqlUserRepo).as<"request">();
// SqlUserRepo ctor: constructor(log: ILogger, db: IDbConnection, table?: string)
// 'table' is optional → its slot is union("string", { value: undefined }).
// One signature, no expansion. Runtime: "string" wins if registered, else the
// always-satisfiable fallback supplies undefined and table is its default.
```

**Lowered output (emitted by transformer):**

```typescript
const services = new DiBuilder();

const ɵreg0 = ConsoleLogger;  // hoisted — defineDeps and add share the same reference
defineDeps(ɵreg0, [[]]);       // zero-arg class: single empty signature
services.add("pkg:ILogger", ɵreg0).as("singleton");

const ɵreg1 = SqlUserRepo;
defineDeps(ɵreg1, [
  // one signature; the optional `table` is a union slot with an undefined fallback
  ["pkg:ILogger", "pkg:IDbConnection", { union: ["string", { value: void 0 }] }],
]);
services.add("pkg:IUserRepo", ɵreg1).as("request");
```

The lowered form is the ABI contract. Libraries publish this form. Consumers without the transformer use it directly. The emitted-call format is kept backward-compatible across `core` semver minors; a breaking change bumps `ABI_VERSION`.

---

## 7. The Runtime Engine (`@fnioc/di`)

### Registration API

Three registration methods on `DiBuilder`, each with a transformer-authored form and an explicit-token form:

```typescript
const services = new DiBuilder<"singleton", "request">();

// Transformer-authored (type-driven):
services.add<ILogger>(ConsoleLogger).as<"singleton">();   // class: token from ILogger
services.add<IUserRepo>(SqlUserRepo).as<"request">();     // class: token from IUserRepo
services.addValue<IConfig>(configInstance);               // value: token from IConfig

// Explicit-token (plugin-less / lowered form):
services.add("pkg:ILogger", ConsoleLogger).as("singleton");           // class
services.addFactory("pkg:IDb", (scope) => new PgDb(scope)).as("singleton"); // factory
services.addValue("pkg:IConfig", configInstance);                     // value
```

- `add(token, Ctor)` — class registration. The concrete is instantiated by the engine with injected deps.
- `addFactory(token, fn)` — factory function. If `fn` has a `defineDeps` record, its parameters are injected; otherwise the engine calls `fn(scope)` so the factory can resolve its own deps.
- `addValue(token, value)` — already-built instance. No deps, no lifetime.

**Last registration wins.** A later `.add` / `.addFactory` / `.addValue` for the same token replaces the earlier one. This is how overrides, test doubles, and environment-specific wiring are done — no separate override API.

`.as<S extends Scopes>()` gives compile-time checking that the tag is a declared scope name. An untagged registration (no `.as()`) is transient.

### `DiBuilder<Scopes>` and the scope union

```typescript
// User supplies their own scope-name union. Transient is implied by omission.
const services = new DiBuilder<"singleton" | "request">();
```

`"transient"` is not a scope name in this system — it is the default absence-of-a-tag behavior. A registration without a lifetime tag is never cached; there is no scope object for transients to live in.

### Scope model

Scopes form a parent chain. The root scope must be a real, app-lifetime object.

```typescript
const root = services.build();                   // mints the root scope (app lifetime)
const req  = root.createScope("request");        // created per HTTP request (for example)
const reqChild = req.createScope("request");     // nested if needed
```

**Resolution walks UP the parent chain for two purposes:**

1. **Registration lookup** — a child scope can shadow/override a parent registration (Angular-style hierarchical DI). Walk up until the token is found.
2. **Instance ownership** — the lifetime tag names which ancestor scope owns and caches the instance. Walk up to the nearest ancestor whose tag matches the registration's tag.

**Rules:**
- Untagged (transient) → fresh instance every resolve, never cached.
- Tagged → walk ancestry for a matching scope. If found: return the cached instance or construct-and-cache there. **If no ancestor matches the tag: throw.** This is not an error to swallow — it is the captive-dependency / misconfiguration detector.
- Never auto-create a scope to satisfy a missing tag. The root/singleton scope is a real object; lazily minting a "singleton" scope per resolve would mean singletons aren't singletons.

### The critical correctness rule (originally §5.4)

**Resolve a service's constructor dependencies relative to the scope that will OWN that service's instance — not the scope that triggered the resolve.**

Example: a `"singleton"` service depends on a `"request"` service. Resolution triggered from a `request` scope walks up and finds the `singleton` ancestor. That `singleton` scope owns the instance, so its deps are resolved relative to the `singleton` scope's chain. The singleton scope's chain has no `"request"` ancestor — it throws. The singleton never silently captures a single request's `IDb` and holds it forever across all requests.

This mirrors `Microsoft.Extensions.DependencyInjection`'s scope-validation discipline. The throw is the feature, not an edge case.

### Greedy overload selection

When a constructor has multiple registered signatures (declared ctor overloads, `@signature` stacking, or `forCtor` chaining), the engine selects by scanning longest → shortest and picking the first **satisfiable** signature. A slot is satisfiable when it is a `LiteralRef` (always), a `FactoryRef` (always), a `ScopeRef` (always), a `Union` with at least one resolvable member, or a string token registered in the owning scope's chain. An unregistered string token blocks the signature. Equal-arity ties break by registration order. When no signature is satisfiable, `NoSatisfiableSignatureError` carries the unsatisfiable tokens — including, for a fully-unsatisfiable `Union` slot, its string-token members — so the error names exactly what to register. The transformer's factory-signature diagnostic (see §8) warns on genuine equal-arity ambiguity.

Note that auto-extraction from an implementation constructor emits a single signature (optionality lives inside it as a `Union` slot), so greedy *multi*-signature selection is exercised only by declared overloads or manual annotation; within one signature, a `Union` slot does its own first-resolvable-wins member selection.

### Cycle detection

A resolution stack (array of tokens currently being resolved) is maintained per `resolve()` call. If a token appears on the stack when it is about to be pushed again, throw an error that includes the full resolution path, e.g.:

```
Circular dependency detected:
  pkg:IUserRepo → pkg:IDb → pkg:IConnectionPool → pkg:IDb
```

### Disposal

Closing a scope disposes the instances it owns in **reverse construction order**. Only instances implementing the disposal contract are disposed.

**Disposal contract: native TC39 `Disposable` / `AsyncDisposable` only.** No custom `dispose()` interface. Use `Symbol.dispose` and `Symbol.asyncDispose` (TypeScript 5.2+; requires `"ESNext.Disposable"` in `lib`, e.g. `["ES2022", "ESNext.Disposable"]` — `ES2022` alone does not provide the disposal symbols).

```typescript
// Scope exposes two close methods:
scope.dispose(): void         // sync close
scope.disposeAsync(): Promise<void>   // async close

// using / await using at the call site:
{
  await using req = root.createScope("request");
  // req.disposeAsync() called automatically on exit
}
```

**Sync `dispose()` throws if the scope owns a `Promise`-valued disposable that needs awaiting.** Fail-loud: the error message directs you to `disposeAsync()`. This prevents silently skipping async teardown.

Disposal order: reverse of construction order within the scope. Instances owned by ancestor scopes are disposed when those scopes close, not when child scopes close.

### Async as values — one resolution channel

The container never awaits. Async is expressed as `Promise<T>` values flowing through the sync channel.

```typescript
// An async factory returns Promise<IDb>
services.addFactory("pkg:IDb", async (scope) => {
  const pool = scope.resolve<IConnectionPool>("pkg:IConnectionPool");
  return new PostgresDb(await pool.connect());
}).as("singleton");

// A service that needs IDb declares the dep as Promise<IDb> and awaits itself
class UserRepo {
  constructor(private db: Promise<IDb>) {}
  async findUser(id: string) {
    return (await this.db).query(`SELECT ...`);
  }
}

// Singleton semantics: the container caches the factory's return verbatim (the Promise).
// Every caller that resolves "pkg:IDb" gets the same Promise and awaits the same result.
// The async factory runs exactly once.
```

The transformer unwraps `Promise<X>` at the dep-extraction step: a constructor parameter typed `Promise<IDb>` maps to the **same token** as `IDb` — `"pkg:IDb"`. Promise-ness lives in the registration's factory, not in a separate token. The consumer's dep is `Promise<IDb>`, but the container looks up the `"pkg:IDb"` registration and returns whatever the factory returned (which happens to be a `Promise`).

Surfacing `Promise<T>` at the dep site is the honest contract. The container must not hide asynchrony behind a covert await. No `resolveAsync()` channel — explicitly rejected.

### Factories (syntactic heuristic)

A constructor parameter whose **type annotation** is literally an arrow or function type returning a registered interface is injected as a **factory** — a callable that produces instances on demand — rather than a resolved instance.

```typescript
// IFoo is registered. This parameter is injected as a factory:
constructor(makeFoo: () => IFoo) { ... }
constructor(makeFoo: (x: B2, y: D4) => IFoo) { ... }

// Named function-interface: NOT a factory — resolves as a normal service by "pkg:IFooThunk"
interface IFooThunk { (): IFoo }
constructor(thunk: IFooThunk) { ... }
```

The named-function-interface escape hatch is deliberate. When your function-typed service would otherwise be interpreted as a factory, name its interface.

**Partial / positional factories.** If the concrete behind `IFoo` has a constructor mixing registered services with caller-supplied scalars, the factory's call signature covers only the **caller-supplied** parameters in their relative order. A caller-supplied parameter is a *primitive scalar* — a bare intrinsic keyword (`string`/`number`/…), a singular literal value, or an anonymous structure — never a named interface/class (a real DI service, which the container resolves).

```typescript
// MyService ctor: (a: IA, b: string, c: IC, d: number, e: IE)
// IA, IC, IE are registered services; b and d are caller-supplied scalars.
// Injected factory type: (b: string, d: number) => IService
// At call time: new MyService(resolve(IA), b, resolve(IC), d, resolve(IE))
```

**Runtime partition (no whole-program analysis).** At instantiation the engine has the per-parameter `DepSlot` array and its live registration map. For each slot: `LiteralRef` → inject its value; `FactoryRef` or `ScopeRef` → resolve accordingly; `Union` → first-resolvable-wins among members; string token in the map → resolve it from the container; string token not in the map → take the next caller-supplied factory argument.

Ramda-style placeholder arguments exposed to callers are rejected — they leak constructor arity/structure. The factory caller sees only the unregistered parameters, in order.

### Override / plugin-less registration — `addFactory` / `addValue`

The recommended plugin-less registration mechanism. No dep array, no decorator, no reflection.

```typescript
// addFactory: a factory function called with the live scope (no defineDeps record
// → scope-based escape hatch); or a pre-annotated factory whose deps are injected.
services.addFactory("pkg:IFoo", (scope) =>
  new TheirFoo(scope.resolve<IBar>("pkg:IBar")),
).as("singleton");

// addValue: an already-built instance, no lifetime (values are always immediate).
services.addValue("pkg:IFoo", cachedFooInstance);
```

**Last registration wins** — a later `add` / `addFactory` / `addValue` for the same token shadows all earlier ones, so any form can override any other. No separate "override" mechanism: overrides are just registrations that happen after the baseline.

Useful for test doubles, third-party instances, async factories (`addFactory` returning `Promise<T>`), and cases where the transformer isn't available.

---

## 8. The Transformer (`@fnioc/transformer`)

### Tooling

`ts-patch` (not `ttypescript` — unmaintained). The transformer runs as a TypeScript language-service plugin inside `ts-patch`'s patched `tsc`. It accesses the TypeScript `TypeChecker` API at compile time to extract constructor parameter types.

### Token generation

The transformer provides a `nameof<IFoo>()`-style compile-time mechanism returning a plain `string`. The return type is `string` — no computed or branded types.

**Token derivation rules:**

- **Package-public type** (reachable through the package's public exports): `packageName:publicExportSubpath/SymbolName`  
  Example: `your-lib:contracts/IFoo`  
  Derive by: walking up to the nearest `package.json` to identify the owning package, checking whether the symbol is publicly exported via the package's `exports`/`main` fields.
- **App-internal type** (not publicly exported): source-relative path token.  
  Example: `./src/services/IUserRepo`

**Version excluded from token.** Tokens do not embed the package version — compatible versions of a dependency unify on the same token. Document the caveat: if two incompatible versions of the same package are installed (version skew), their tokens collide, which produces a registration conflict rather than two isolated containers. The standard mitigation is the same as for any semver peer dep: keep compatible versions.

`nameof<IFoo>()` at the authoring level compiles to the derived string. In the transformer, a call `nameof<IFoo>()` in source is rewritten to its string value at compile time — callers never see the generation logic at runtime.

### Dep extraction and `defineDeps` emission

**Which constructor(s) are read.** If the class has **declared overloads** (bodyless ctor declarations preceding the implementation), each declared overload becomes one emitted signature, in declaration order; the implementation signature is ignored entirely (TypeScript hides the impl from callers, so the transformer does too). Otherwise the **implementation** constructor drives extraction and yields exactly **one** signature. A class with no explicit constructor (or a zero-param one) yields a single empty signature `[[]]`.

For each parameter, the transformer emits one `DepSlot`, applying these rules **in order** (first match wins):

1. **`ResolveScope`-typed** → `ScopeRef` (`{ scope: true }`) — the live resolution scope.
2. **`Inject<T, "tok">` brand** → the branded token string. The brand is union-aware, so it also works through `| undefined` on an optional parameter (`x?: Inject<T, "tok">`).
3. **Optional in any form** — `x?: X`, `x: X = default`, `x: X | undefined`, `x: X | void`, at any position → `union(<non-nullish slots>, { value: undefined })` with the `LiteralRef` fallback **last**. A whole-type `undefined`/`void` (no non-nullish core) emits the bare `{ value: undefined }`.
4. **Inline function type** (`() => IFoo`) → `FactoryRef` (PRD §7), keyed on the return type's token.
5. **Inline union type** (`A | B`, syntactically a union node, two+ members, not pure-literal, not wide `boolean`) → `Union` of per-member slots in declaration order. A `| null` member survives as `{ value: null }`; `| undefined` was already consumed by rule 3.
6. **Singular literal** (`"dev"`, `42`, `true`, `1n`) or **nullish singleton** (`null` → `{ value: null }`) → `LiteralRef`.
7. **Named type** — interface, class, type alias, intrinsic (`string`, `number`, `boolean`, `symbol`, `bigint`, `any`, `unknown`, `never`), or **pure-literal union** (`"a" | "b"` → single sorted ` | `-joined, JSON-quoted token) → a string token via the token-generation rules. Wide `boolean` lands here as `"boolean"`. An unregistered token causes `UnregisteredTokenError` at runtime — not a compile error.
8. **Anonymous inline structure** with no `Inject` brand → diagnostic `990006` (`UnderivableToken`). Hard compile error. Fix: name the type or use `Inject<T, "explicit-token">`.

`Promise<X>` parameters are unwrapped first: the slot derives from `X`, not from `Promise<X>`.

Finally, the transformer hoists the class reference to `const ɵregN = ClassName` and uses that identifier in both `defineDeps(ɵregN, ...)` and the registration call (so the class is evaluated once and both calls reference the same object), emitting `defineDeps(ɵregN, [[...]])` immediately before the lowered registration call.

The multi-signature `signatures` array is therefore exercised by **declared ctor overloads** and **manual** `@signature`/`forCtor` overloads; auto-extraction from an implementation constructor always emits exactly one signature, with optionality expressed *inside* it via `Union` slots rather than as extra shorter signatures. This is strictly more expressive than the previous trailing-overload expansion: an interior optional parameter (`(a: X | undefined, b: Y)`) is representable as a per-param union, whereas suffix-dropping could only drop trailing params.

### Lowered output / ABI contract

The lowered form is a contract. Libraries compile with the transformer and publish the lowered JS; consumers run it without the transformer. The emitted-call format is versioned via `ABI_VERSION` and kept backward-compatible.

```typescript
// Author code — `table?: string` is optional → union-with-fallback, one signature
services.add<IUserRepo>(SqlUserRepo).as<"request">();

// Lowered (transformer emits) — the class is hoisted; ONE signature emitted
const ɵreg0 = SqlUserRepo;
defineDeps(ɵreg0, [
  ["pkg:ILogger", "pkg:IDbConnection", { union: ["string", { value: void 0 }] }],
]);
services.add("pkg:IUserRepo", ɵreg0).as("request");
// On resolve: the union tries "string" first; if it is not registered, the
// always-satisfiable { value: void 0 } member supplies undefined, and `table`
// takes its default. The optional param never makes the signature unsatisfiable.
```

### Factory-signature diagnostic (originally §4.5)

The transformer validates factory signatures (and any hand-declared factory parameters in `@signature` / `forCtor`) against the target constructor's **caller-supplied** parameters in order. Under Rule 1 a named interface/class always tokenizes and is container-resolved, so "caller-supplied" no longer means "underivable" — it means a *primitive scalar*: a bare intrinsic keyword token (`string`/`number`/…), a singular literal (Rule 2), or an anonymous structure with no token. This is the primary value-add of using the transformer — it provides compile-time feedback when a factory's declared call signature doesn't match the scalars the container will actually leave for the caller.

Additional diagnostics the transformer can emit where statically visible:
- A consumer declaring `IDb` as a direct dep when the service is async-registered (should be `Promise<IDb>`).
- Equal-arity overload ambiguity (two signatures of the same length for the same constructor).

### Already-annotated classes

When the transformer encounters a class that already has a `@signature` decorator or a `forCtor` annotation, it treats the manual annotation as **authoritative** and skips dep extraction for that class. It emits an **info diagnostic** — never silent, never double-writes.

### Fully-dynamic classes

A constructor that the transformer cannot statically inspect (e.g. a class reference passed through a variable, a dynamically-constructed class) gets no dep array emitted. At resolve time, if the constructor has parameters but no DepRecord in the WeakMap, the engine **throws with guidance**:

```
No dep metadata found for <ClassName>. The constructor has parameters but
no @signature, forCtor, or transformer-generated defineDeps call was found.
Use forCtor(...).signature(...) or useFactory to register it manually.
```

A genuine zero-argument constructor is `new`ed directly with no dep lookup.

---

## 9. Progressive Enhancement / The Portable Substrate

The transformer is optional — the engine is always usable hand-fed. The relationship mirrors JSX and `createElement`:

| Layer | JSX analogy | `@fnioc` |
|---|---|---|
| Author surface | `<Button onClick={...}>` | `services.add<IFoo>(Foo).as<"singleton">()` |
| Compiler | TSX → `createElement` calls | transformer → `defineDeps` + string-token `.add()` |
| Runtime | React reconciler reads `createElement` output | Engine reads DepRecords, resolves graph |
| Plugin-less | Write `createElement` calls by hand | Write `defineDeps` + token strings by hand |

**Three plugin-less paths for overrides and standalone use:**

1. **`addFactory` / `addValue`** — recommended. Wire deps in a plain closure or provide a pre-built value; no token array, no reflection. A later registration for the same token overrides earlier ones (last wins).
2. **`@signature` decorator** — for your own classes where you want constructor injection without the transformer. Hand-author the token array; unchecked (no transformer to verify tokens match params).
3. **`forCtor(ctor).signature(...)`** — same as `@signature` but for classes you don't own.

A library author compiles once with the transformer and publishes the lowered JS. Consumers of that library — transformer or not — get the registrations for free. Consumers without the transformer who need to register *their own* services use one of the three paths above.

---

## 10. Packaging & Publishing

### Toolchain

Mirrors `fnclaude@fnclaude`:
- **Bun** — runtime, package manager, test runner.
- **Moon** (`moonrepo`) — task orchestration. Per-package `moon.yml` with `:lint`, `:test`, `:build` tasks.
- **release-please** — per-package release PRs. Config: `separate-pull-requests: true`, `include-component-in-tag: true`.
- **mise** — pins `bun` + `moon` versions; installs the pre-commit `hooksPath`.

Standard files: `bun.lock`, `bunfig.toml`, `.moon/workspace.yml`, `.moon/toolchain.yml`, `mise.toml`, `tsconfig.base.json`, per-package `moon.yml` + `tsconfig.json`.

### The one deviation from `fnclaude`

`fnclaude` is a Bun-run application with no build step — `main` points directly at `./src/*.ts`. `ioc` is a library consumed under Node.js, webpack, Vite, tsc, and similar — **not** Bun in the consumer's project. Therefore:

- Each package requires a real `tsc` → `dist/` build step producing `.js` + `.d.ts` files.
- `package.json` `main`, `types`, and `exports` fields point at `dist/`.
- Moon `build` tasks declare `outputs: ['dist']`.
- The transformer especially must ship consumable JS + declaration files — it is loaded by ts-patch into the consumer's tsc invocation.

### TypeScript config

```jsonc
// tsconfig.base.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "ESNext.Disposable"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "isolatedModules": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

`lib: ["ESNext.Disposable"]` is what enables the native `Disposable` / `AsyncDisposable` / `using` / `await using` support the engine relies on.

### CI — `ci.yml`

**`verify` job:**
1. Checkout with `fetch-depth: 0` and 3× retry.
2. `mise-action` to restore pinned tool versions.
3. `bun install --frozen-lockfile`.
4. `moon run :lint :test :build`.

**`publish` job** (gated on release-please tag):
1. `release-please-action` with `AUTOMERGE_PAT` for auto-merge.
2. OIDC trusted-publishing — **no long-lived `NPM_TOKEN`**. Provider: GitHub Actions; repo: `fnioc/ioc`; workflow: `ci.yml`. The workflow filename `ci.yml` is load-bearing — changing it breaks the trusted-publisher configuration on npmjs.com.
3. `workspace:*` → concrete version rewrite before publish.
4. Topological sort: publish dependencies before dependents (core → di, core → transformer).
5. Verify-deps-resolve guard.
6. `npm publish --provenance`.

**`auto-merge.yml`:** enables squash auto-merge via `AUTOMERGE_PAT`.

**`FUNDING.yml`:** `github: fnrhombus`, `buy_me_a_coffee: fnrhombus`.

### npm bootstrap

The `@fnioc` npm scope is claimed using the Bitwarden `rhombulus` god token (retrieved from the vault, never committed). The same token configures OIDC trusted publishers on npmjs.com (mirrors `claim-npm.ps1`). Ongoing CI publishes via OIDC; no long-lived `NPM_TOKEN` is stored as a secret. The repository requires the `AUTOMERGE_PAT` secret.

### `@rhombus-toolkit` reuse policy

Prefer native over toolkit wherever a native feature has superseded it. Confirmed native for `ioc`: `Disposable` / `AsyncDisposable` / `Symbol.dispose` / `Symbol.asyncDispose` / `using` / `await using` — do not use a toolkit `Disposable`. The global-symbol singleton substrate is implemented directly in `@fnioc/core` — do not depend on `@rhombus-toolkit/singleton`. Audit each `@rhombus-toolkit/*` package for publication status and maintenance before depending on it; the `rhombus-toolkit/ts` repo uses Rush/Heft and is stale.

---

## 11. Explicitly Rejected — Do Not Reintroduce

| Decision | Rationale |
|---|---|
| Legacy decorators (`experimentalDecorators`) | Hard non-starter. Also eliminates `emitDecoratorMetadata` and parameter decorators (which do not exist in TC39 decorators). |
| `emitDecoratorMetadata` | Only works in legacy decorator mode; eliminated with the above. |
| Parameter decorators | Do not exist in TC39 standard decorators. |
| `reflect-metadata` | Interface-blind (`design:paramtypes` maps interfaces to `Object`); global side-effecting polyfill; redundant with the transformer doing the same job at compile time. |
| `Symbol.metadata` as the dep store | Only auto-populated by decorators; would force the transformer to emulate its object-creation/inheritance semantics; requires a polyfill. The WeakMap is correct. |
| Writing dep data onto the class as primary store (`$inject` static / symbol static) | Prototype-inheritance bleed (subclass silently inherits parent's dep array); pollutes the class surface. |
| `static $inject` in v1 | Reintroduces prototype-bleed that the WeakMap design exists to prevent; `forCtor` makes it unnecessary. If ever added: read once, cache into the WeakMap keyed by the exact ctor — never walk the prototype chain. |
| Ramda-style placeholder args exposed to factory callers | Leaks constructor arity/structure to call sites; the §4.5 diagnostic provides fail-loud safety without that exposure. |
| Computed/branded return types for `nameof` | `string` is sufficient; the token value is plain text, not a branded or literal TS type. |
| `toString()` / AST-parsing of ctor arg names at runtime | Fragile under minification; the transformer supplies precise data instead. |
| `@injectable` as the decorator name | Rejected on principle by the project author — use `@signature`. |
| A separate async resolution channel / `resolveAsync()` | Async is values through the sync channel; one channel, honest contract. |
| A separate `@fnioc/abi` package | The ABI types and the WeakMap/`defineDeps` that read-write them are one intrinsic unit; splitting buys no decoupling. `@fnioc/core` is the ABI. |

---

## 12. Reference Implementations

Lift patterns, not code.

| Reference | What to lift |
|---|---|
| `@wessberg/di` + `@wessberg/di-compiler` | Closest prior art for the transformer side: compile-time, interface-driven, no decorators, no `reflect-metadata`. Study how it extracts constructor signatures and lowers registrations. Also the reference for the deferred wessberg-style `add<I, C>()`. |
| Autofac (C#) | Scope model (`InstancePerMatchingLifetimeScope(tag)` + throw-when-no-ancestor-carries-the-tag); delegate factories (`Func<T>`, `Func<X,Y,T>`, parameter matching + duplicate-type ambiguity); greedy constructor selection. |
| `Microsoft.Extensions.DependencyInjection` | Captive-dependency detection / scope validation (the §5.4 resolve-deps-from-owning-scope rule). |
| AngularJS 1.x injector | `$inject` positional array; `annotate()` annotation strategies. |
| Awilix (`jeffijoe/awilix`, JS) | JS-idiomatic plumbing: scope objects + parent chain, registration map, lazy resolution, disposer hooks, cycle detection with a resolution path. Take the plumbing, not its fixed lifetime enum. |

---

## 13. Resolved Open Questions

These were the open questions from the original handoff (originally §12); each is now resolved.

| Question | Resolution |
|---|---|
| Exact lowered-call ABI shape and versioning scheme | `DepRecord { abi: number, signatures: DepSlot[][] }` in `@fnioc/core`, where `DepSlot = Token \| LiteralRef \| FactoryRef \| ScopeRef \| Union`. `ABI_VERSION` integer exported from `core`; version-suffixed `Symbol.for` key for global WeakMap. Semver per package via release-please; `ABI_VERSION` bumped only on wire-format break. |
| Support `static $inject` fallback in v1? | Dropped. Reintroduces prototype-inheritance bleed the WeakMap design prevents. `forCtor` is the plugin-less alternative for classes you don't own. |
| Behavior when transformer encounters already-hand-annotated class | Manual annotation is authoritative. Transformer skips emission and emits an info diagnostic. Never silent; never double-writes. |
| Behavior for fully-dynamic registration (ctor transformer can't see) | No dep array emitted. At resolve time: if ctor has params but no DepRecord → throw with actionable guidance (`forCtor` or `useFactory`). Zero-arg ctor → `new` directly. |
| Async resolution / async disposal | Async = values through the sync channel. Container never awaits. Async disposal retained (native `AsyncDisposable`). No `resolveAsync` channel. |
| Global-symbol WeakMap hardening — v1 or deferred? | Promoted to v1. `globalThis[Symbol.for("@fnioc/core:deps@N")]` with `??=` init; version-suffixed key; `Symbol.for` only. |
| Decorator name — `@injectable` or something else? | `@signature`. `@injectable` rejected on principle. |
| Separate `@fnioc/abi` package? | No. `@fnioc/core` is the ABI. |

---

## 14. Future / Deferred

Not in scope for v1. Do not design around these prematurely — they are explicitly out of scope.

- **Wessberg-style `services.add<Interface, Concrete>()`** — ctor inferred from the generic, no value argument. The transformer would resolve the implementation ctor and its dep graph from the type parameter. Blocked partly by TypeScript's lack of partial type-argument inference (two-type-param `add<IFoo, Foo>()` would force a redundant type arg). `@wessberg/di` is the reference implementation.
- **By-name dep/factory matching** — the transformer reads ctor parameter identifiers from the AST (no decorators needed). Fixes the same-type positional ambiguity footgun (two `string` params in the same ctor; positional matching can't distinguish them). Deferred.
- **Arg/parameter-name override mechanism** — if by-name matching ever needs explicit overrides. Note: standard decorators have no parameter decorators, so a different mechanism would be required.
- **`@fnioc/eslint-plugin`** — surfaces the factory-signature diagnostic in-editor (currently only fires at tsc time via the transformer).
- **`unplugin` wrapper** — lets the transformer run inside Vite, Rollup, esbuild, and webpack without ts-patch.
- **Testing utilities** — DI-aware test helpers (mock scope creation, override utilities, etc.).
