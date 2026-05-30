# ioc

**Type-driven, interface-first dependency injection for TypeScript.** Author against rich, type-checked, interface-based DI; a compile-time transformer *lowers* it into plain-data runtime calls — exactly like TypeScript → JavaScript or JSX → `createElement`. The runtime engine is small and works **with or without** the transformer, which is what lets libraries publish DI registrations that any consumer can use.

No decorators by default. No `reflect-metadata`. No runtime reflection.

## Packages

| Package | What it is |
|---|---|
| [`@fnioc/core`](packages/core) | The substrate: the dependency-metadata ABI, the global-symbol `WeakMap`, `defineDeps`, and the `@signature` / `forCtor` authoring surfaces. |
| [`@fnioc/di`](packages/di) | The runtime engine: `DiBuilder`, scopes, resolution, captive-dependency protection, factories, disposal. |
| [`@fnioc/transformer`](packages/transformer) | The build-time `ts-patch` transformer: token generation, dependency extraction, registration lowering, and the factory-signature diagnostic. |

```
core ← di
core ← transformer        (di and transformer are independent)
```

## Status

In active development. See [`PRD.md`](PRD.md) for the full design and [`PLAN.md`](PLAN.md) for the implementation roadmap and progress.

## License

MIT © Thomas Butler
