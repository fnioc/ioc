# Changelog

## [11.0.0](https://github.com/fnioc/ioc/compare/core-v10.1.0...core-v11.0.0) (2026-07-05)


### Chores

* **core:** Synchronize fnioc versions

## [10.1.0](https://github.com/fnioc/ioc/compare/core-v10.1.0...core-v10.1.0) (2026-07-05)


### Chores

* **core:** Synchronize fnioc versions

## [10.1.0](https://github.com/fnioc/ioc/compare/core-v10.0.0...core-v10.1.0) (2026-07-04)


### Features

* **transformer:** tokenless addFactory&lt;I&gt;(fn) with overload-faithful factory params ([#96](https://github.com/fnioc/ioc/issues/96)) ([57d50e3](https://github.com/fnioc/ioc/commit/57d50e39ce1d015a472d3e216ada81b92688cbeb))

## [10.0.0](https://github.com/fnioc/ioc/compare/core-v9.0.0...core-v10.0.0) (2026-07-04)


### Chores

* **core:** Synchronize fnioc versions

## [9.0.0](https://github.com/fnioc/ioc/compare/core-v8.0.0...core-v9.0.0) (2026-07-03)


### ⚠ BREAKING CHANGES

* **core:** publish @fnioc/core as a pure .d.ts abstractions package ([#83](https://github.com/fnioc/ioc/issues/83))
* async resolution + signatures-on-registration (core/di/transformer) ([#82](https://github.com/fnioc/ioc/issues/82))
* the `@signature` class decorator and the `signature` export (from both `@fnioc/core` and `@fnioc/di`) are removed. Author constructor signatures with `forCtor(Class).signature(...)` instead.
* closed-generic tokens change token derivation for any generic type reference. Code recompiled with the new transformer re-lowers cleanly; lowered JS published by an older transformer will not unify with new closed tokens for the same generic type.
* **di:** DiBuilder, DiBuilderClass, and DiBuilderCtor are removed from @fnioc/di. Callers must replace all three with their ServiceManifest-prefixed counterparts.
* token-surface redesign — full token-user parity (Union, Inject, resolveFactory params, drop hole) ([#35](https://github.com/fnioc/ioc/issues/35))
* **di:** A required (non-optional) parameter whose type is unresolvable now causes resolve<T>() to throw NoSatisfiableSignatureError instead of silently constructing with undefined. Migration: make the param optional or defaulted (overload expansion handles it), or use the factory form resolve<(arg: T) => R>() to supply the value at call time. The object-shape add(token, { useFactory }) / add(token, { useValue }) API is also removed.

### Features

* async resolution + signatures-on-registration (core/di/transformer) ([#82](https://github.com/fnioc/ioc/issues/82)) ([16bd184](https://github.com/fnioc/ioc/commit/16bd1843822767201778616c9f9bfa297f0a1a5c))
* **core:** FactoryRef ABI slot + di adaptation (Phase 2D.1) ([#5](https://github.com/fnioc/ioc/issues/5)) ([2f2e915](https://github.com/fnioc/ioc/commit/2f2e9151f2134c040b330ccda397cbf5e384b770))
* **core:** implement dep-metadata ABI, global WeakMap, and authoring surfaces ([#1](https://github.com/fnioc/ioc/issues/1)) ([6c5d75d](https://github.com/fnioc/ioc/commit/6c5d75d17ac7217e33a12f55b8e6e3af79274576))
* **core:** publish @fnioc/core as a pure .d.ts abstractions package ([#83](https://github.com/fnioc/ioc/issues/83)) ([82ab3e7](https://github.com/fnioc/ioc/commit/82ab3e7581db481e0051d30136430a7869a4a0f5))
* **di:** redesign dependency-registration and resolution surface ([#28](https://github.com/fnioc/ioc/issues/28)) ([18fe261](https://github.com/fnioc/ioc/commit/18fe2615f1ad9ccad02014354d8e4a1843ba280f))
* **di:** rename DiBuilder to ServiceManifest ([#72](https://github.com/fnioc/ioc/issues/72)) ([c6b5862](https://github.com/fnioc/ioc/commit/c6b58628d77732f340b9384cee2aeaa1f29329d2))
* open generics (core/di/transformer) ([#75](https://github.com/fnioc/ioc/issues/75)) ([74930ba](https://github.com/fnioc/ioc/commit/74930baaa404a8a9024657679941c6a320e28dce))
* private core, redesigned di service-collection, bundled publish ([#24](https://github.com/fnioc/ioc/issues/24)) ([8c48b98](https://github.com/fnioc/ioc/commit/8c48b9842d5f5bf179f964e47cf2b5a8ccd7eb90))
* remove the [@signature](https://github.com/signature) class decorator ([#80](https://github.com/fnioc/ioc/issues/80)) ([75a58a2](https://github.com/fnioc/ioc/commit/75a58a222a83d611a4f9ef991056478ee889d266))
* token-surface redesign — full token-user parity (Union, Inject, resolveFactory params, drop hole) ([#35](https://github.com/fnioc/ioc/issues/35)) ([77a2384](https://github.com/fnioc/ioc/commit/77a2384155109ff33e73eceb5b957f13a6d18b52))
* tokenize all named types + literal value supply (LiteralRef) ([#51](https://github.com/fnioc/ioc/issues/51)) ([52a70e7](https://github.com/fnioc/ioc/commit/52a70e7ad34d88899c61a85480800260897689ee))

## 1.0.0 (2026-05-30)


### Features

* **core:** FactoryRef ABI slot + di adaptation (Phase 2D.1) ([#5](https://github.com/fnioc/ioc/issues/5)) ([2f2e915](https://github.com/fnioc/ioc/commit/2f2e9151f2134c040b330ccda397cbf5e384b770))
* **core:** implement dep-metadata ABI, global WeakMap, and authoring surfaces ([#1](https://github.com/fnioc/ioc/issues/1)) ([6c5d75d](https://github.com/fnioc/ioc/commit/6c5d75d17ac7217e33a12f55b8e6e3af79274576))
