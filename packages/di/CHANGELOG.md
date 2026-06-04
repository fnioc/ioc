# Changelog

## [4.1.0](https://github.com/fnioc/ioc/compare/di-v4.0.1...di-v4.1.0) (2026-06-04)


### Features

* tokenize all named types + literal value supply (LiteralRef) ([#51](https://github.com/fnioc/ioc/issues/51)) ([52a70e7](https://github.com/fnioc/ioc/commit/52a70e7ad34d88899c61a85480800260897689ee))
* **transformer:** declared inline-factory args become caller-supplied params ([#59](https://github.com/fnioc/ioc/issues/59)) ([b8f63fb](https://github.com/fnioc/ioc/commit/b8f63fbbd94373404348c5be7b541203f01d2e92))


### Bug Fixes

* **transformer:** wide-boolean optional + honor all construct overloads on reference paths ([#58](https://github.com/fnioc/ioc/issues/58)) ([648a44e](https://github.com/fnioc/ioc/commit/648a44e5e164770fd11fea831b58ca86d93eb958))

## [4.0.1](https://github.com/fnioc/ioc/compare/di-v4.0.0...di-v4.0.1) (2026-06-03)


### Bug Fixes

* **tooling:** resolve workspace packages to source for live cross-package types ([#40](https://github.com/fnioc/ioc/issues/40)) ([7c86ab1](https://github.com/fnioc/ioc/commit/7c86ab170be3c7def6a8b3bbfec709078febc3c2))

## [4.0.0](https://github.com/fnioc/ioc/compare/di-v3.0.0...di-v4.0.0) (2026-06-02)


### ⚠ BREAKING CHANGES

* token-surface redesign — full token-user parity (Union, Inject, resolveFactory params, drop hole) ([#35](https://github.com/fnioc/ioc/issues/35))

### Features

* token-surface redesign — full token-user parity (Union, Inject, resolveFactory params, drop hole) ([#35](https://github.com/fnioc/ioc/issues/35)) ([77a2384](https://github.com/fnioc/ioc/commit/77a2384155109ff33e73eceb5b957f13a6d18b52))

## [3.0.0](https://github.com/fnioc/ioc/compare/di-v2.0.0...di-v3.0.0) (2026-06-02)


### ⚠ BREAKING CHANGES

* **di:** ServiceProvider, Resolver/ScopeFactory split, seal-on-build ([#32](https://github.com/fnioc/ioc/issues/32))

### Features

* **di:** ServiceProvider, Resolver/ScopeFactory split, seal-on-build ([#32](https://github.com/fnioc/ioc/issues/32)) ([07c2ae6](https://github.com/fnioc/ioc/commit/07c2ae6b9a0ffc52dafd27cd4a4aeaec0d7fb251))

## [2.0.0](https://github.com/fnioc/ioc/compare/di-v1.0.0...di-v2.0.0) (2026-06-01)


### ⚠ BREAKING CHANGES

* **di:** A required (non-optional) parameter whose type is unresolvable now causes resolve<T>() to throw NoSatisfiableSignatureError instead of silently constructing with undefined. Migration: make the param optional or defaulted (overload expansion handles it), or use the factory form resolve<(arg: T) => R>() to supply the value at call time. The object-shape add(token, { useFactory }) / add(token, { useValue }) API is also removed.

### Features

* **di:** redesign dependency-registration and resolution surface ([#28](https://github.com/fnioc/ioc/issues/28)) ([18fe261](https://github.com/fnioc/ioc/commit/18fe2615f1ad9ccad02014354d8e4a1843ba280f))
* private core, redesigned di service-collection, bundled publish ([#24](https://github.com/fnioc/ioc/issues/24)) ([8c48b98](https://github.com/fnioc/ioc/commit/8c48b9842d5f5bf179f964e47cf2b5a8ccd7eb90))

## 1.0.0 (2026-05-30)


### Features

* **core:** FactoryRef ABI slot + di adaptation (Phase 2D.1) ([#5](https://github.com/fnioc/ioc/issues/5)) ([2f2e915](https://github.com/fnioc/ioc/commit/2f2e9151f2134c040b330ccda397cbf5e384b770))
* **di:** base runtime engine (Phase 2A) ([#3](https://github.com/fnioc/ioc/issues/3)) ([4a6e972](https://github.com/fnioc/ioc/commit/4a6e97269985b97c843aa5e9a7b032e81fae9959))
* **di:** inject factories and fill holes (Phase 2D.2) ([#6](https://github.com/fnioc/ioc/issues/6)) ([ef5509e](https://github.com/fnioc/ioc/commit/ef5509e094b5de78364ce5f1b3aa43c0aa6b6d5f))
