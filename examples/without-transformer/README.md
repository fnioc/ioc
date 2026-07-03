# @fnioc/di — without the transformer

The **same app** as [`../with-transformer`](../with-transformer), wired by hand
with no ts-patch plugin. Both examples import the *identical* contracts + service
classes from [`@fnioc-examples/shared`](../shared); the ONLY difference is the
wiring style, so this is the side-by-side for what the transformer automates.

## What it shows

- Plugin-less registration: explicit string tokens —
  `services.add("app/IGreeter", Greeter).as("singleton")`.
- Hand-written constructor signatures: `services.add(GREETER, Greeter, [[LOGGER, CLOCK]])`.
  A class with ctor params and no signature on its registration throws
  `MissingMetadataError`, so every such class carries its signature as the
  registration's third argument.
- The same singleton sharing and `request` child-scope lifetimes as the
  transformer example.
- **`union(LOGGER, METRICS)`**: `UnionConsumer` takes a union slot — the first
  registered member (`ILogger`) wins.
- **The `Inject` brand replicated by hand**: `DiagnosticsService` carries an
  `Inject<IClock, "app:primary-clock">` brand in its shared source; without the
  plugin, `services.add(DIAGNOSTICS, DiagnosticsService, [[PRIMARY_CLOCK, LOGGER]])`
  reproduces the pin the transformer would derive.
- **Open generics, by hand**: an open template registration
  (`add(REPOSITORY_TEMPLATE, SqlRepository, [[LOGGER, typeArg(1)]])`) with its
  dep signatures carried on the registration; a closed exact registration
  (`add(closeToken(REPOSITORY, ORDER), InMemoryRepository, [[{ value: ORDER }]])`)
  that beats the open fallback; a generic-on-generic open template for a generic
  dependent (`add(AUDITOR_TEMPLATE, RepositoryAuditor, [[REPOSITORY_TEMPLATE]])`);
  and multiple closings resolved as distinct singletons via
  `closeToken(REPOSITORY, USER)`.

## What the transformer would have done for you

| Step | With transformer | By hand (here) |
| --- | --- | --- |
| Token | derived (`./shared/src/contracts/IGreeter`) | chosen string (`app/IGreeter`) |
| Registration | `add<IGreeter>(Greeter)` | `add("app/IGreeter", Greeter)` |
| Ctor signature | derived automatically, carried inline as the registration's third argument | written by hand, same inline form: `add(GREETER, Greeter, [[LOGGER, CLOCK]])` |
| Resolve | tokenless `resolve<IGreeter>()` | explicit `resolve(GREETER)` |
| Open generic | `add<IRepository<$<1>>>(SqlRepository<$<1>>)` | `add("app/IRepository<$1>", SqlRepository, [[…, typeArg(1)]])` |
| `Typeof<T>` witness | derived `{ typeArg: 1 }` slot | hand-written `typeArg(1)` |

## How it works

The shared source is imported by a relative path (`../../shared/src/index.js`),
so plain `tsc` compiles it into this example's own `dist` — no bundler. The
compiled entry is `dist/without-transformer/src/main.js`; `@fnioc/di` resolves at
runtime through the `workspace:*` symlink.

## Run it

```sh
moon run examples-without-transformer:build   # tsc compile to dist/
node dist/without-transformer/src/main.js      # run it
moon run examples-without-transformer:test     # run + assert stdout (expected.txt)
moon run examples-without-transformer:lint     # typecheck
```
