# @fnioc/transformer

The build-time `ts-patch` transformer for `ioc`. It accesses the TypeScript `TypeChecker` API at compile time to automate the three tasks that would otherwise be tedious to hand-write:

1. **Token generation** — derives a stable string token from each TypeScript interface type.
2. **Dep extraction** — reads constructor parameter types and converts them to token arrays.
3. **Registration lowering** — rewrites `services.add<IFoo>(Foo).as<"scope">()` to its plain-data runtime equivalent, emitting `defineDeps(Foo, [[...tokens]])` immediately before each registration.

The result is the portable substrate: libraries compile once with the transformer and publish the lowered JS. Consumers without the transformer use that output directly.

---

## Setup

The transformer runs inside `ts-patch`'s patched `tsc`. It does not work with `ttypescript` (unmaintained).

### Install

```sh
npm install --save-dev @fnioc/transformer ts-patch
```

### Patch the compiler

```sh
npx ts-patch install
```

Run this once after installing `ts-patch`. It patches the local `typescript` installation so that the `plugins` array in `tsconfig.json` is honored at compile time.

### Wire into `tsconfig.json`

```jsonc
{
  "compilerOptions": {
    "plugins": [
      { "transform": "@fnioc/transformer" }
    ]
  }
}
```

### Use `tspc` in your build script

`ts-patch` ships `tspc` as a drop-in replacement for `tsc`. Use it in your `package.json` build script:

```json
{
  "scripts": {
    "build": "tspc"
  }
}
```

`tsc` (unpatched) will ignore the `plugins` array. `tspc` processes it.

---

## Token derivation

Tokens are stable strings derived from TypeScript interface types. The derivation rule depends on whether the type is publicly exported from a package or internal to the application.

| Type | Rule | Example token |
|---|---|---|
| Package-public type (reachable through the package's `exports`/`main`) | `packageName:exportSubpath/SymbolName` | `your-lib:contracts/IFoo` |
| App-internal type (not publicly exported) | Source-relative path token | `./src/services/IUserRepo` |

The transformer walks up to the nearest `package.json` to identify the owning package, then checks whether the symbol is publicly reachable.

### `Inject<T, K extends Token>` — per-arg token override

To pin a specific token for one constructor or factory parameter, use the `Inject` brand (re-exported from `@fnioc/transformer`, zero runtime):

```ts
import type { Inject } from "@fnioc/transformer";

class Handler {
  constructor(
    cache: Inject<ICache, "pkg:redis-cache">,  // pinned token
    log: ILogger,                               // derived normally
  ) {}
}
```

Works in any type position the transformer reads: class ctor params, inline factory params, return types. The value type stays `T` — a plain `ICache` is assignable; the brand property is optional.

`Inject` is the escape hatch for anonymous or purely structural types — types without a name that the transformer cannot tokenize. Named types (including primitive keywords like `string`, `number`, `boolean`) always produce a token; `Inject` is not needed for them.

### `nameof<T>()`

The transformer provides a compile-time token helper. Each `nameof<IFoo>()` call in source is rewritten to the derived string token at build time — callers never ship the generation logic at runtime.

```ts
import { nameof } from "@fnioc/transformer";

const token = nameof<IUserRepo>();
// → "your-pkg:contracts/IUserRepo" at compile time
```

If the transformer is not wired up and `nameof` runs at runtime, it throws:

```
nameof<T>() requires the @fnioc/transformer plugin. Add { "transform":
"@fnioc/transformer" } to your tsconfig "plugins", or pass a token string.
```

This is intentional: un-transformed code fails loudly rather than silently returning `undefined`.

### Version skew caveat

Tokens do not embed the package version. Two compatible versions of the same package unify on the same token — the usual case. If two **incompatible** versions of a package are installed simultaneously, their tokens will collide, producing a registration conflict rather than two isolated containers. The mitigation is the same as for any peer dependency: keep compatible versions aligned. This is an acknowledged trade-off; version-embedded tokens would prevent legitimate version unification.

---

## What gets lowered

For each `services.add<IFoo>(Foo).as<"scope">()` call the transformer finds, it:

1. Reads `Foo`'s constructor parameter types via the TypeChecker.
2. Derives a slot per parameter:
   - Interfaces, class types, named type aliases, and named built-ins (`string`, `number`, `boolean`, `symbol`, `bigint`, `any`, `unknown`, `never`) → string token per the derivation rule above (named built-ins tokenize by keyword name). An unregistered token is a runtime miss, not a compile error.
   - `Promise<X>` → token for `X` (not a `Promise<X>` token — see below).
   - **Inline function types** (`() => IFoo`, `(a: B) => IFoo`) → `{ type: "pkg:IFoo" }` (a `FactoryRef` — see factory detection below).
   - **Inline union types** (`A | B` written directly at the annotation site) → `{ union: ["pkg:A", "pkg:B"] }` (a `Union` slot — see named vs inline unions below).
   - **Anonymous inline structural types** (no name, no `Inject` brand) → **hard compile error** (990006 `UnderivableToken`): "name this type or brand it with `Inject<T, 'token'>`."
3. Emits `defineDeps(Foo, [[...slots]])` immediately before the registration call.
4. Rewrites the call from the type-driven form to the plain-data form.

```ts
// Author code
services.add<IUserRepo>(SqlUserRepo).as<"request">();
// SqlUserRepo constructor: (log: ILogger, db: IDbConnection, table: string)
// 'table' has type string → token "string" (runtime miss if "string" is unregistered)
// use Inject<string, "app:tableName"> to pin a custom token, or supply a registration override

// Lowered output (with table branded as Inject<string, "app:tableName">)
defineDeps(SqlUserRepo, [["pkg:ILogger", "pkg:IDbConnection", "app:tableName"]]);
services.add("pkg:IUserRepo", SqlUserRepo).as("request");
```

For a class with a single constructor, the transformer emits exactly one signature. For a class with declared overloads, it emits one signature per bodyless overload declaration in order — the implementation signature is ignored (it is not caller-visible).

### `Promise<X>` unwrap

A constructor parameter typed `Promise<IDb>` maps to the same token as `IDb`: `"pkg:IDb"`. The container caches whatever the factory returns, which may be a `Promise`. The consumer's dep is `Promise<IDb>`, but the token is `"pkg:IDb"` — Promise-ness lives in the factory's return, not in the token.

---

## Factory detection

A constructor parameter whose type annotation is an **inline function-type literal** (`ts.FunctionTypeNode`) is detected as a factory and emitted as `{ type: "<token>" }` in the `defineDeps` signature. The token is derived from the return type after unwrapping any `Promise<X>`. An optional `params` field lists the inline factory's caller-supplied parameter tokens in authored order.

```ts
// Inline function-type annotation → factory ref keyed on "pkg:IDb"
constructor(makeDb: () => IDb) { ... }
constructor(makeDb: (id: string) => Promise<IDb>) { ... }

// Named type reference → normal token "pkg:IDbFactory", NOT a factory
interface IDbFactory { (): IDb }
constructor(makeDb: IDbFactory) { ... }
```

Detection is **purely syntactic** — it reads the annotation node kind, not the resolved `ts.Type`. This is intentional: an inline arrow type and a named callable interface are structurally identical once resolved; only the syntax tells them apart. The named-interface form is the deliberate opt-out.

### Emitted form

```ts
// Author code
class RequestHandler {
  constructor(
    private log: ILogger,        // resolved dep
    private makeDb: () => IDb,   // factory-injected, zero caller args
  ) {}
}

// Lowered output
defineDeps(RequestHandler, [["pkg:ILogger", { type: "pkg:IDb" }]]);
```

With caller-supplied params:

```ts
// Author code
class RequestHandler {
  constructor(
    private log: ILogger,
    private makeRepo: (tableName: string) => IUserRepo,
  ) {}
}

// Lowered output — params lists the caller-supplied token(s)
defineDeps(RequestHandler, [["pkg:ILogger", { type: "pkg:IUserRepo", params: ["app:tableName"] }]]);
```

---

## Named vs inline unions

Detection is **purely syntactic** — the shape of the annotation node, not the resolved type.

| Annotation form | Lowered slot | What to register |
|---|---|---|
| `constructor(x: A \| B)` — inline | `Union` — alternatives | any or all of A, B (first registered wins) |
| `type AB = A \| B; constructor(x: AB)` — named alias | single token for `AB` | `AB` itself |

```ts
// Inline union → Union slot, try IRedis first then IMemoryCache
class Handler {
  constructor(cache: IRedis | IMemoryCache, log: ILogger) {}
}
// Lowered: { union: ["pkg:IRedis", "pkg:IMemoryCache"] }

// Named alias → single "pkg:CacheProvider" token
type CacheProvider = IRedis | IMemoryCache;
class Handler {
  constructor(cache: CacheProvider, log: ILogger) {}
}
// Lowered: "pkg:CacheProvider"
```

Registering `IRedis` or `IMemoryCache` separately does nothing for a `CacheProvider`-typed parameter — you must register `CacheProvider`. See the wiki for the full named-vs-inline treatment.

---

## Already-annotated classes

When the transformer encounters a class that already has a `@signature` decorator or a `forCtor` annotation, it treats the manual annotation as **authoritative**:

- It skips dep extraction and `defineDeps` emission for that class.
- It emits an **info diagnostic** — never silent, never double-writes.

This is the opt-out path. Hand-annotate a class with `@signature` or `forCtor` to take full control of its signature, and the transformer will step aside.

---

## Fully-dynamic classes

If the transformer cannot statically inspect a constructor (a class reference passed through a variable, a dynamically-constructed class), it emits no `defineDeps` call. At resolve time, `@fnioc/di` checks the global-symbol Map and throws with guidance if the constructor has parameters but no record:

```
No dep metadata found for <ClassName>. The constructor has parameters but
no @signature, forCtor, or transformer-generated defineDeps call was found.
Use forCtor(...).signature(...) or useFactory to register it manually.
```

A genuine zero-argument constructor is `new`ed directly without a dep lookup.

---

## Diagnostics

The transformer emits warnings during `tsc`/`tspc` for three classes of statically-detectable misconfigurations. Each diagnostic is anchored at the relevant node in the source file. All checks are conservative — they fire only where a mismatch is statically certain, never on a guess.

### Factory-signature mismatch (code 990003)

When the transformer can see the concrete class behind a factory-typed parameter, it compares the factory's declared call signature against the target constructor's caller-supplied parameters in order. If the counts don't match, it warns:

```
Factory parameter "makeRepo" takes 2 argument(s), but the factory caller
must supply 1 — the caller-supplied parameter(s) of the produced type's
constructor. List exactly those, in order.
```

This is the primary value-add of running the transformer: compile-time feedback when a factory's declared arity doesn't match what the container will actually expose at runtime.

### Async mismatch (code 990004)

A constructor parameter typed as a bare interface (`IDb`) when the token is registered via an async `useFactory` (one returning `Promise<IDb>`). The container hands back the `Promise` verbatim, so the parameter must be declared `Promise<IDb>` and awaited by the consumer:

```
Dependency "db" is registered async, so the container returns a Promise.
Declare it as Promise<IDb> and await it where you use it.
```

This check fires only when the `useFactory` for the same token is visibly `async` or has an annotated `Promise<...>` return type in the same file.

### Equal-arity overload ambiguity (code 990005)

Two manually-registered constructor signatures (via stacked `@signature` decorators or chained `forCtor(...).signature(...)` calls) have the same length. The engine's greedy selection picks overloads by argument count, so two same-length signatures cannot be distinguished:

```
MyService has two constructor signatures of the same length (2). The
container picks an overload by argument count, so it cannot tell them
apart. Give them different lengths.
```

This check runs on all registrations, including manually-annotated ones.

### Underivable token (code 990006)

A constructor or factory parameter whose type is an anonymous inline structural type — no name, no `Inject<T, "tok">` brand:

```
cannot derive a token for this type — name the type or brand the parameter
with `Inject<T, 'my:token'>`
```

This is a hard compile error. Named types (interfaces, classes, type aliases, primitive keywords) always produce a token and never trigger this diagnostic. The fix is to either define a named type or brand the parameter with `Inject<T, "my:token">`.

An `@fnioc/eslint-plugin` that surfaces these diagnostics in-editor is planned for a future release.

---

## Plugin-less consumers

The transformer is not required to *use* `@fnioc/di`. It automates annotation for classes you own. When you don't have the transformer configured:

- Libraries compiled with the transformer publish plain-data lowered JS — their registrations work without any plugin on the consumer side.
- For your own classes, use `useFactory`/`useValue`, `@signature`, or `forCtor`. See [`@fnioc/di`](../di/README.md) and [`@fnioc/core`](../core/README.md) for those APIs.
