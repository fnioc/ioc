# Changelog

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
