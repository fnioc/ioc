# Changelog

## [3.0.1](https://github.com/fnioc/ioc/compare/transformer-v3.0.0...transformer-v3.0.1) (2026-06-03)


### Bug Fixes

* **tooling:** resolve workspace packages to source for live cross-package types ([#40](https://github.com/fnioc/ioc/issues/40)) ([7c86ab1](https://github.com/fnioc/ioc/commit/7c86ab170be3c7def6a8b3bbfec709078febc3c2))
* **transformer:** honor Inject brand on optional params (union-aware token detection) ([#38](https://github.com/fnioc/ioc/issues/38)) ([8b0c28b](https://github.com/fnioc/ioc/commit/8b0c28bf6ba4c7c6348c4ac02ffb38fc6ff46c60))

## [3.0.0](https://github.com/fnioc/ioc/compare/transformer-v2.0.0...transformer-v3.0.0) (2026-06-02)


### ⚠ BREAKING CHANGES

* token-surface redesign — full token-user parity (Union, Inject, resolveFactory params, drop hole) ([#35](https://github.com/fnioc/ioc/issues/35))

### Features

* token-surface redesign — full token-user parity (Union, Inject, resolveFactory params, drop hole) ([#35](https://github.com/fnioc/ioc/issues/35)) ([77a2384](https://github.com/fnioc/ioc/commit/77a2384155109ff33e73eceb5b957f13a6d18b52))

## [2.0.0](https://github.com/fnioc/ioc/compare/transformer-v1.1.0...transformer-v2.0.0) (2026-06-02)


### ⚠ BREAKING CHANGES

* **di:** ServiceProvider, Resolver/ScopeFactory split, seal-on-build ([#32](https://github.com/fnioc/ioc/issues/32))
* **di:** A required (non-optional) parameter whose type is unresolvable now causes resolve<T>() to throw NoSatisfiableSignatureError instead of silently constructing with undefined. Migration: make the param optional or defaulted (overload expansion handles it), or use the factory form resolve<(arg: T) => R>() to supply the value at call time. The object-shape add(token, { useFactory }) / add(token, { useValue }) API is also removed.

### Features

* **di:** redesign dependency-registration and resolution surface ([#28](https://github.com/fnioc/ioc/issues/28)) ([18fe261](https://github.com/fnioc/ioc/commit/18fe2615f1ad9ccad02014354d8e4a1843ba280f))
* **di:** ServiceProvider, Resolver/ScopeFactory split, seal-on-build ([#32](https://github.com/fnioc/ioc/issues/32)) ([07c2ae6](https://github.com/fnioc/ioc/commit/07c2ae6b9a0ffc52dafd27cd4a4aeaec0d7fb251))

## [1.1.0](https://github.com/fnioc/ioc/compare/transformer-v1.0.0...transformer-v1.1.0) (2026-06-01)


### Features

* private core, redesigned di service-collection, bundled publish ([#24](https://github.com/fnioc/ioc/issues/24)) ([8c48b98](https://github.com/fnioc/ioc/commit/8c48b9842d5f5bf179f964e47cf2b5a8ccd7eb90))

## 1.0.0 (2026-05-30)


### Features

* **transformer:** factory detection & signature diagnostics (Phase 2D.3) ([#7](https://github.com/fnioc/ioc/issues/7)) ([cb50268](https://github.com/fnioc/ioc/commit/cb50268777af074f6ba6dd3145b142a2936e783a))
* **transformer:** token gen, dep extraction, registration lowering ([#4](https://github.com/fnioc/ioc/issues/4)) ([518e586](https://github.com/fnioc/ioc/commit/518e5860aaa5a87533ceb1e78fdb7151b6c67bff))


### Bug Fixes

* **transformer:** hand-declared factory diagnostics + publish prep ([#15](https://github.com/fnioc/ioc/issues/15)) ([8935e38](https://github.com/fnioc/ioc/commit/8935e388bfbde6e940dbb5c80d16683fb2e55824))
