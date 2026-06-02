# Examples

Two runnable apps demonstrating [`@fnioc/di`](../packages/di). Both share a core
app — a singleton logger, clock, and greeter plus a request-scoped id — and each
adds surface-specific feature demonstrations, so the contrast is purely the
**wiring style** plus the new contract features each path surfaces.

| Example | Authoring | Build | Extra features |
| --- | --- | --- | --- |
| [`with-transformer`](./with-transformer) | type-driven: `add<IGreeter>(Greeter)`, no string tokens | `tspc` (the [`@fnioc/transformer`](../packages/transformer) ts-patch plugin) | `Inject<T,"tok">` brand, inline `A \| B` union |
| [`without-transformer`](./without-transformer) | plugin-less: explicit tokens + hand-written metadata | plain `tsc` | `union("tok:A","tok:B")`, `forCtor(ThirdParty).signature(...)` |

Both import `@fnioc/di` (and the transformer, in the first) as **bare
specifiers** via `workspace:*` deps — modeling a real external consumer, never
reaching into `packages/` by relative path.

## Run them

```sh
moon run examples-with-transformer:start
moon run examples-without-transformer:start
```

Each example's `test` task asserts its stdout against a checked-in
`expected.txt`. See each example's README for details and the transformer
before/after table.

## The takeaway

The transformer removes the two pieces of boilerplate the manual example writes
by hand: the string token (derived from the interface type) and the
constructor-dependency metadata (injected as `defineDeps(...)`). Everything
downstream — the `DiBuilder`, scopes, lifetimes, resolution — is identical.
