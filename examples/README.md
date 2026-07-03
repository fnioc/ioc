# Examples

Two runnable apps demonstrating [`@fnioc/di`](../packages/di). They wire the
**identical** contracts and service classes — the single canonical set lives in
[`shared`](./shared) — so the ONLY difference between the two is the **wiring
style**. Diff [`with-transformer/src/main.ts`](./with-transformer/src/main.ts)
against [`without-transformer/src/main.ts`](./without-transformer/src/main.ts)
and everything but the authoring mechanism is the same.

| Example | Authoring | Build |
| --- | --- | --- |
| [`with-transformer`](./with-transformer) | type-driven: `add<IGreeter>(Greeter)`, tokenless `resolve<IGreeter>()`, `$<N>` / `Typeof<T>` placeholders | `tspc` (the [`@fnioc/transformer`](../packages/transformer) ts-patch plugin) |
| [`without-transformer`](./without-transformer) | plugin-less: explicit tokens, hand-written signature arrays, manual `closeToken` / `typeArg` | plain `tsc` |

## The shared package

[`@fnioc-examples/shared`](./shared) is **source-only** — its `main`/`types`
point straight at the TypeScript source, and there is no build step. Each example
imports it by a *relative* path (`../../shared/src/index.js`), so plain `tsc` /
`tspc` compiles the shared source into that example's own `dist` (plugin-less
source inlining, no bundler). The bare package specifier is never imported at
runtime — only the classes, via the relative path.

## Feature × plugin matrix

Every cell below is demonstrated by the two examples wiring the **same** shared
classes two different ways.

| | No plugin (`without-transformer`) | With plugin (`with-transformer`) |
| --- | --- | --- |
| **Baseline DI** | explicit tokens + a hand-written signature array (the registration's third argument); `union(...)`; the `Inject` brand replicated by a hand-written signature | `add<IGreeter>(Greeter)`; inline `A \| B` union; the `Inject<T,"tok">` brand derived automatically |
| **Open generics** | manual template-token registration (`add("app/IRepository<$1>", SqlRepository, [[…, typeArg(1)]])`), a closed exact registration, a hole-template signature for a generic dependent, `closeToken` / `typeArg` helpers | placeholder registration (`add<IRepository<$<1>>>(SqlRepository<$<1>>)`), a closed instantiation-expression registration, tokenless closing resolves, a `Typeof<T>` witness |

**ABI unification.** The transformer's lowered output for an open or closed
generic registration is exactly the plain-data `add(token, ctor, signatures)`
form a plugin-less consumer would write by hand — proven directly in the
integration suite, which resolves a transformer-compiled closing against a
manually-registered template and vice versa. There is no format difference
between "compiled" and "hand-written" open-generic registrations.

## Run them

```sh
moon run examples-with-transformer:build
node examples/with-transformer/dist/with-transformer/src/main.js

moon run examples-without-transformer:build
node examples/without-transformer/dist/without-transformer/src/main.js
```

Each example's `test` task asserts its stdout against a checked-in
`expected.txt`. See each example's README for details and the transformer
before/after table.

## The takeaway

The transformer removes the two pieces of boilerplate the manual example writes
by hand: the string token (derived from the interface type) and the
constructor-dependency metadata (carried inline as the registration's third
argument). Everything downstream — the `ServiceManifest`, scopes, lifetimes,
resolution — is identical, right down to the shared classes both examples pull
from `@fnioc-examples/shared`.
