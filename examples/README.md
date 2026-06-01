# Examples

Two runnable apps demonstrating [`@fnioc/di`](../packages/di). Both implement the
**identical** app — a singleton logger, clock, and greeter plus a request-scoped
id — so the contrast between them is purely the **wiring style**.

| Example | Authoring | Build |
| --- | --- | --- |
| [`with-transformer`](./with-transformer) | type-driven: `add<IGreeter>(Greeter)`, no string tokens | `tspc` (the [`@fnioc/transformer`](../packages/transformer) ts-patch plugin) |
| [`without-transformer`](./without-transformer) | plugin-less: explicit tokens + hand-written metadata | plain `tsc` |

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
