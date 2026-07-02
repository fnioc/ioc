# @fnioc/di — with the transformer

A runnable example of [`@fnioc/di`](../../packages/di) authored **interface-first**
with the [`@fnioc/transformer`](../../packages/transformer) ts-patch plugin.

The contracts and service **classes** live in
[`@fnioc-examples/shared`](../shared) — the single canonical set both examples
wire. This example and [`../without-transformer`](../without-transformer) import
the *identical* classes; the ONLY difference between the two `main.ts` files is
the **wiring style**. Diff them side by side and everything but the authoring
mechanism is the same.

## What it shows

- Type-driven registration: `services.add<IGreeter>(Greeter).as<"singleton">()` —
  no string tokens by hand. The transformer lowers each call and injects the
  constructor-dependency metadata.
- Tokenless resolution: `resolve<IGreeter>()` — the transformer derives the token
  from the type argument.
- Singleton lifetime + a `request` child scope with per-scope lifetimes.
- **Inline union** (`A | B` ctor param): `UnionConsumer(sink: ILogger | IMetricsBackend)`
  lowers to a `{ union: [...] }` slot; the first registered member wins.
- **`Inject<T, "tok">` brand**: `DiagnosticsService` pins its `clock` param to
  `"app:primary-clock"`, overriding structural derivation.
- **Open generics**: one placeholder registration
  (`add<IRepository<$<1>>>(SqlRepository<$<1>>)`) covers every closing of
  `IRepository<T>`; a closed instantiation-expression registration
  (`add<IRepository<Order>>(InMemoryRepository<Order>)`) beats the open fallback
  for its closing; distinct closings resolve (tokenlessly, via
  `resolve<IRepository<User>>()`) as distinct singletons; the `Typeof<T>` witness
  hands each instance its closing's token string; and a generic-on-generic
  auditor (`add<IAuditor<$<1>>>(RepositoryAuditor<$<1>>)`) closes recursively.

## How it works

`tspc` (ts-patch's patched compiler) runs `@fnioc/transformer` during `build`.
The shared source is imported by a relative path (`../../shared/src/index.js`),
so `tspc` compiles it into this example's own `dist` — plugin-less source
inlining, no bundler. Inspect `dist/with-transformer/src/main.js` afterwards to
see the lowered output: every `add<I>(C)` becomes `add("token", C)` and each
non-generic class gets a `defineDeps(...)` prelude; generic registrations instead
carry their dep signatures as `add()`'s third argument
(`add("./shared/src/contracts/IRepository<$1>", SqlRepository, [[...]])`). The
emitted `import { defineDeps } from "@fnioc/di"` resolves at runtime through the
`workspace:*` symlink.

The tokenless authored form (`resolve<IRepository<User>>()`) lowers to the
derived closed token (`./shared/src/contracts/IRepository<./shared/src/contracts/User>`).

## Run it

```sh
moon run examples-with-transformer:build   # tspc compile to dist/
node dist/with-transformer/src/main.js     # run it
moon run examples-with-transformer:test    # run + assert stdout (expected.txt)
moon run examples-with-transformer:lint    # typecheck
```

Or directly with bun: `bun run build && bun run start`.
