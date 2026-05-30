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

### Version skew caveat

Tokens do not embed the package version. Two compatible versions of the same package unify on the same token — the usual case. If two **incompatible** versions of a package are installed simultaneously, their tokens will collide, producing a registration conflict rather than two isolated containers. The mitigation is the same as for any peer dependency: keep compatible versions aligned. This is an acknowledged trade-off; version-embedded tokens would prevent legitimate version unification.

---

## What gets lowered

For each `services.add<IFoo>(Foo).as<"scope">()` call the transformer finds, it:

1. Reads `Foo`'s constructor parameter types via the TypeChecker.
2. Derives a token per parameter:
   - Interfaces and class types → string token per the derivation rule above.
   - `Promise<X>` → token for `X` (not a `Promise<X>` token — see below).
   - Primitives (`string`, `number`, `boolean`, `symbol`, `bigint`), `unknown`, `any`, `void` → `null` (a hole sentinel; these cannot be interface tokens).
3. Emits `defineDeps(Foo, [[...tokens]])` immediately before the registration call.
4. Rewrites the call from the type-driven form to the plain-data form.

```typescript
// Author code
services.add<IUserRepo>(SqlUserRepo).as<"request">();
// SqlUserRepo constructor: (log: ILogger, db: IDbConnection, table: string)

// Lowered output
defineDeps(SqlUserRepo, [["pkg:ILogger", "pkg:IDbConnection", null]]);
// null = hole for 'table' (string primitive)
services.add("pkg:IUserRepo", SqlUserRepo).as("request");
```

The transformer normally emits exactly one signature per class — the single canonical constructor signature it sees statically.

### `Promise<X>` unwrap

A constructor parameter typed `Promise<IDb>` maps to the same token as `IDb`: `"pkg:IDb"`. The container caches whatever the factory returns, which may be a `Promise`. The consumer's dep is `Promise<IDb>`, but the token is `"pkg:IDb"` — Promise-ness lives in the factory's return, not in the token.

---

## Already-annotated classes

When the transformer encounters a class that already has a `@signature` decorator or a `forCtor` annotation, it treats the manual annotation as **authoritative**:

- It skips dep extraction and `defineDeps` emission for that class.
- It emits an **info diagnostic** — never silent, never double-writes.

This is the opt-out path. Hand-annotate a class with `@signature` or `forCtor` to take full control of its signature, and the transformer will step aside.

---

## Fully-dynamic classes

If the transformer cannot statically inspect a constructor (a class reference passed through a variable, a dynamically-constructed class), it emits no `defineDeps` call. At resolve time, `@fnioc/di` checks the WeakMap and throws with guidance if the constructor has parameters but no record:

```
No dep metadata found for <ClassName>. The constructor has parameters but
no @signature, forCtor, or transformer-generated defineDeps call was found.
Use forCtor(...).signature(...) or useFactory to register it manually.
```

A genuine zero-argument constructor is `new`ed directly without a dep lookup.

---

## Factory-signature diagnostic

When the transformer can statically see a factory-typed constructor parameter (one whose type annotation is a literal arrow or function type returning a registered interface), it validates the factory's call signature against the target constructor's **unregistered** parameters in order.

This is the primary value-add of running the transformer: compile-time feedback when a factory's declared call signature doesn't match what the container will actually pass at runtime. The diagnostic fires during `tsc`/`tspc` — no separate lint step needed.

Additional diagnostics the transformer emits where statically visible:

| Diagnostic | Condition |
|---|---|
| Wrong dep type for async registration | A consumer declares `IDb` as a direct dep when the service is async-registered (should be `Promise<IDb>`). |
| Equal-arity overload ambiguity | Two signatures of the same length for the same constructor — greedy selection cannot distinguish them. |

An `@fnioc/eslint-plugin` that surfaces these diagnostics in-editor is planned for a future release.

---

## Plugin-less consumers

The transformer is not required to *use* `@fnioc/di`. It automates annotation for classes you own. When you don't have the transformer configured:

- Libraries compiled with the transformer publish plain-data lowered JS — their registrations work without any plugin on the consumer side.
- For your own classes, use `useFactory`/`useValue`, `@signature`, or `forCtor`. See [`@fnioc/di`](../di/README.md) and [`@fnioc/core`](../core/README.md) for those APIs.
