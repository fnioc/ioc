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

## Open generics

**Breaking change.** Before this release, type arguments were dropped during token derivation — `IFoo<A>` and `IFoo<B>` both tokenized to the same `pkg:IFoo` and silently collided. Generic type references now tokenize fully applied, recursively: `pkg:IFoo<pkg:A>` and `pkg:IFoo<pkg:B>` are distinct. Non-generic types are unaffected — zero change. (`@fnioc/transformer` ships this as `feat!`; `@fnioc/core` and `@fnioc/di` ship the open-generics substrate as additive `feat`s.)

TypeScript generics are erased — there is exactly one JS class per generic implementation — so "closing" a generic registration needs no runtime type machinery. It's token algebra: a closed token (`pkg:IFoo<pkg:User>`) is an ordinary, distinct cache key; an open template (`pkg:IFoo<$1>`) gets substituted at resolve time. See [`@fnioc/di`](../di/README.md#open-generics) for the resolution side.

### Closed-token grammar

Canonical, recursive: `base<arg1,arg2>` — no whitespace around the `<` `>` `,` separators (reserved characters, along with `$`, the hole sentinel). Each arg is itself a token, so nesting recurses:

```
pkg:IFoo<pkg:IBar<./src/Baz>>
```

- **Generic types always tokenize fully applied.** A bare mention of `IFoo` where `interface IFoo<T = string>` resolves via the checker to `IFoo<string>` and tokenizes closed: `pkg:IFoo<string>`. Type-parameter defaults arrive pre-applied — you don't need to write `IFoo<string>` explicitly.
- **`Promise<X>` unwrap is preserved exactly as today** — at the top level (a constructor parameter or factory return typed `Promise<IDb>` maps to the `IDb` token) and nowhere else. **Inside a type argument, there is no unwrap**: `IFoo<Promise<X>>` tokenizes `Promise<...>` applied like any other generic — `pkg:IFoo<Promise<pkg:X>>`.
- **Default-lib types tokenize by their bare name.** A type argument whose primary declaration lives in a TypeScript default-lib file (`Promise`, `Map`, …) tokenizes as the bare symbol name rather than an absolute path — `Promise<pkg:X>`, not a machine-dependent lib path.
- **Alias-wins is preserved.** `type UserRepo = IRepository<User>` tokenizes as the alias (`./src/UserRepo`), **not** the closed form `pkg:IRepository<pkg:User>` — consistent with the named-vs-inline union rule (see the wiki). This applies whenever the reference carries an alias symbol with no directly-applied type arguments of its own; loudly documented because it's easy to expect the opposite.

**v1 service-token restriction.** In a service token — the type argument to `add<...>()` or `resolve<...>()` — every type-arg position must be either **all holes** or **all concrete**. `IRepository<$<1>>` (open) and `IRepository<User>` (closed) are both valid; `IRepository<$<1>, User>` (mixed) is a compile error (990008, below). Dependency templates on the *impl* side may mix holes and concrete args freely — `IMap<string, $<1>>` is a perfectly valid dep type.

### Placeholder / skolem authoring — `Hole<N, C>`, `$<N>`

Author an open registration by writing a hole in place of a type argument, both on the service token and the implementation:

```ts
import type { $ } from "@fnioc/transformer";

class SqlRepository<T> implements IRepository<T> {
  constructor(private db: IDbConnection) {}
}

services.add<IRepository<$<1>>>(SqlRepository<$<1>>);
```

`$<N>` is unbounded sugar for `Hole<N>` — a zero-runtime compile-time brand the transformer detects structurally (mirroring `Inject` brand detection), so it works whether referenced directly or through an alias. When the implementation's own type parameter carries a constraint, use `Hole<N, C>` directly so the skolem satisfies it:

```ts
class SqlRepository<T extends Entity> implements IRepository<T> {
  constructor(private db: IDbConnection) {}
}

services.add<IRepository<$<1>>>(SqlRepository<Hole<1, Entity>>);
// Hole<1, Entity> IS an Entity (constraint carrier `C`), so it satisfies
// `T extends Entity` where a bare `Hole<1>` ($<1>) would not typecheck.
```

A bare generic class reference with no type arguments, whose constructor parameters reference its own type parameters, is a compile error (990007, below) — supply an instantiation expression naming holes or concrete types.

### Instantiation expressions — closing (or holing) the impl side

The implementation side accepts a TypeScript instantiation expression (`Foo<...>` in value position, TS 4.7+) with either holes or concrete type arguments — including reordering and repeats:

```ts
class Pair<A, B> { constructor(readonly a: A, readonly b: B) {} }

// Inverted order: the transformer reads the checker's INSTANTIATED
// construct-signature param types, so the substitution is already applied —
// param 0 (type A) is bound to $2, param 1 (type B) is bound to $1.
services.add<IPair<$<1>, $<2>>>(Pair<$<2>, $<1>>);

// Fully closed — no holes at all. Still generic-impl handling (registration-
// carried deps, below), because the ctor is still Pair, shared with every
// other Pair<...> registration.
services.add<IPair<User, Order>>(Pair<User, Order>);
```

The emitted value is the plain, un-parameterized ctor (`Pair`, type arguments stripped) — instantiation expressions only ever affect how the transformer *reads* the checker, never what's emitted at runtime.

### `Typeof<T>` — the witness parameter

`Typeof<T>` is the `typeof(T)` analog: a constructor parameter of this type receives the **token string** the type argument `T` was bound to, letting an implementation introspect its own closing. It is type-driven — the transformer infers the hole from `T` — where the manual `typeArg(n)` names the hole positionally.

```ts
class SqlRepository<T> implements IRepository<T> {
  constructor(
    private db: IDbConnection,
    private entityToken: Typeof<T>,
  ) {}

  get category() { return this.entityToken; } // "pkg:User", "pkg:Order", …
}

services.add<IRepository<$<1>>>(SqlRepository<$<1>>);
```

For an **open** binding (`T` is a hole), the transformer emits a `{ typeArg: N }` slot that resolution substitutes per closing. For a **concrete** binding (a closed registration via an instantiation expression), the transformer emits the derived token directly as a literal value slot — no substitution needed, since the value is already known at compile time.

### Registration-carried dep signatures

Generic implementations — open templates and closed registrations made via an instantiation expression alike — can't use the usual ctor-keyed `defineDeps` emission: the dep-metadata store is keyed on the ctor **object**, and the same class backing two closings (or two templates) would collide there. Instead, the transformer emits the signatures literal directly as a **third argument to `add()`**, and skips both the `defineDeps` call and the `const ɵregN = …` hoist entirely:

```ts
// Author
services.add<IRepository<$<1>>>(SqlRepository<$<1>>);

// Lowered — no hoist, no defineDeps; the signature lives on the registration
services.add("pkg:IRepository<$1>", SqlRepository, [
  ["pkg:IDbConnection", { typeArg: 1 }],
]);
```

```ts
// Author — closed via instantiation expression
services.add<IRepository<User>>(SqlRepository<User>);

// Lowered — Typeof<T> binds concrete, so the slot is a literal value
services.add("pkg:IRepository<pkg:User>", SqlRepository, [
  ["pkg:IDbConnection", { value: "pkg:User" }],
]);
```

**Non-generic registrations are unaffected** — they keep today's hoist + `defineDeps` emission, byte-for-byte. This is a regression-gated guarantee, not an incidental side effect. See [`@fnioc/di`](../di/README.md#open-generics) for how the runtime resolves and closes these against resolve-time type arguments.

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

When the transformer encounters a class that already has a `forCtor` annotation, it treats the manual annotation as **authoritative**:

- It skips dep extraction and `defineDeps` emission for that class.
- It emits an **info diagnostic** — never silent, never double-writes.

This is the opt-out path. Hand-annotate a class with `forCtor` to take full control of its signature, and the transformer will step aside.

---

## Fully-dynamic classes

If the transformer cannot statically inspect a constructor (a class reference passed through a variable, a dynamically-constructed class), it emits no `defineDeps` call. At resolve time, `@fnioc/di` checks the global-symbol Map and throws with guidance if the constructor has parameters but no record:

```
No dep metadata found for <ClassName> (resolving "<token>"). The
constructor has parameters but no forCtor or transformer-generated
defineDeps call was found. Use forCtor(...).signature(...) or register
it with useFactory to wire it manually.
```

A genuine zero-argument constructor is `new`ed directly without a dep lookup.

---

## Diagnostics

The transformer emits warnings during `tsc`/`tspc` for several classes of statically-detectable misconfigurations. Each diagnostic is anchored at the relevant node in the source file. All checks are conservative — they fire only where a mismatch is statically certain, never on a guess.

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

Two manually-registered constructor signatures (via chained `forCtor(...).signature(...)` calls) have the same length. The engine's greedy selection picks overloads by argument count, so two same-length signatures cannot be distinguished:

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

### Unbound type parameter (code 990007)

A bare generic class reference with no type arguments (open or concrete) whose constructor parameters reference its own type parameters — the transformer can't derive a token for an unbound `T`:

```
this parameter references an unbound type parameter — register the class via
an instantiation expression that binds it (`add<IFoo<$<1>>>(Foo<$<1>>)` for an
open template, or `Foo<Concrete>` for a closed one)
```

Fix: write an instantiation expression on the implementation, e.g. `SqlRepository<$<1>>` (open) or `SqlRepository<User>` (closed).

### Mixed service-token arguments (code 990008)

A service token's type arguments mix holes and concrete types — v1 requires every position to be **all holes** or **all concrete**:

```
open service token "./app/IRepository<$1,./app/User>" mixes holes and concrete
type args — every type arg of an open service token must be a hole
(`IFoo<$<1>,$<2>>`); close the token fully or open it fully
```

Fix: split into a fully-open registration (`IRepository<$<1>, $<2>>`) or a fully-closed one (`IRepository<User, Order>`).

### Open token on value or factory registration (code 990009)

`addValue`/`addFactory` targeting an open service token — there is no single value or factory that can serve every closing:

```
open template token "./app/IRepository<$1>" on addValue — open registrations
are class registrations only; register a class implementation or close the
token
```

Fix: use a class registration (`add<IRepository<$<1>>>(SqlRepository<$<1>>)`), or register each closing separately under a concrete token.

### Dependency hole not in service template (code 990010)

A constructor parameter's dep type references a hole (`$N`) that doesn't appear anywhere in the service token's own template — the hole has nothing to bind to at close time:

```
dependency hole(s) $2 are not bound by the service token
"./app/IRepository<$1>" — every hole a dependency references must appear in
the service token's type arguments
```

Fix: add the missing hole to the service token, or replace the dependency's reference with a concrete type.

---

## Plugin-less consumers

The transformer is not required to *use* `@fnioc/di`. It automates annotation for classes you own. When you don't have the transformer configured:

- Libraries compiled with the transformer publish plain-data lowered JS — their registrations work without any plugin on the consumer side.
- For your own classes, use `useFactory`/`useValue`, or `forCtor`. See [`@fnioc/di`](../di/README.md) and [`@fnioc/core`](../core/README.md) for those APIs.
