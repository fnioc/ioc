# @fnioc/di — without the transformer

The **same app** as [`../with-transformer`](../with-transformer), wired by hand
with no ts-patch plugin. The only difference between the two examples is the
wiring style, so this is the side-by-side for what the transformer automates.

## What it shows

- Plugin-less registration: explicit string tokens —
  `services.add("app/IGreeter", Greeter).as("singleton")`.
- Hand-written constructor metadata: `forCtor(Greeter).signature(ILogger, IClock)`.
  A class with ctor params and no registered metadata throws
  `MissingMetadataError`, so every such class must declare its signature.
- The same singleton sharing and `request` child-scope lifetimes as the
  transformer example.
- **`union("tok:A", "tok:B")`**: `DiagnosticsReporter` takes a union slot — the
  first registered member (`ILogger`) wins. Registering `IMetricsBackend` instead
  would fall through to that.
- **`forCtor(ThirdParty).signature(...)`**: `ThirdPartyFormatter` is wired with a
  complete manual signature, exactly as the transformer would emit for a class you
  don't own.

## What the transformer would have done for you

| Step | With transformer | By hand (here) |
| --- | --- | --- |
| Token | derived (`./contracts/IGreeter`) | chosen string (`app/IGreeter`) |
| Registration | `add<IGreeter>(Greeter)` | `add("app/IGreeter", Greeter)` |
| Ctor metadata | injected `defineDeps(...)` | `forCtor(Greeter).signature(...)` |

## Run it

```sh
moon run examples-without-transformer:build   # tsc compile to dist/
moon run examples-without-transformer:start   # run it
moon run examples-without-transformer:test    # run + assert stdout (expected.txt)
moon run examples-without-transformer:lint    # typecheck
```

Or directly with bun, no build step: `bun run src/main.ts`.
