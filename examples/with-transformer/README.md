# @fnioc/di — with the transformer

A runnable example of [`@fnioc/di`](../../packages/di) authored **interface-first**
with the [`@fnioc/transformer`](../../packages/transformer) ts-patch plugin.

## What it shows

- Type-driven registration: `services.add<IGreeter>(Greeter).as<"singleton">()` —
  no string tokens are written by hand. The transformer lowers each call to the
  string-token form and injects the constructor-dependency metadata.
- Constructor injection: `Greeter(logger: ILogger, clock: IClock)` resolves both
  deps from their interface types automatically.
- Singleton lifetime: the greeter and its logger are shared across resolves.
- A `request` child scope (`root.createScope("request")`) owning a
  request-scoped service, demonstrating per-scope lifetimes.
- **Inline union** (`A | B` ctor param): `UnionConsumer(sink: ILogger | IMetricsBackend)`
  — the transformer emits a `{ union: [...] }` slot; the first registered member wins.
- **`Inject<T, "tok">` brand**: `DiagnosticsService` pins its `clock` param to
  `"app:primary-clock"` overriding the structural derivation, so a specific
  `SystemClock` instance registered under that token is injected.

## How it works

`tspc` (ts-patch's patched compiler) runs `@fnioc/transformer` during `build`.
Inspect `dist/main.js` afterwards to see the lowered output — every
`add<I>(C)` becomes `add("./contracts/I", C)` and each class gets a
`defineDeps(...)` prelude. The emitted `import { defineDeps } from "@fnioc/di"`
resolves at runtime through the `workspace:*` symlink.

`resolve(...)` is **not** lowered, so the resolve calls use the same
source-relative tokens the transformer emits (`./contracts/I<Name>`).

## Run it

```sh
moon run examples-with-transformer:build   # tspc compile to dist/
moon run examples-with-transformer:start   # run it
moon run examples-with-transformer:test    # run + assert stdout (expected.txt)
moon run examples-with-transformer:lint    # typecheck
```

Or directly with bun: `bun run build && bun run start`.
