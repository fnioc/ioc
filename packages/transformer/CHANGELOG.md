# Changelog

## [9.0.0](https://github.com/fnioc/ioc/compare/transformer-v8.0.0...transformer-v9.0.0) (2026-07-03)


### ⚠ BREAKING CHANGES

* **core:** publish @fnioc/core as a pure .d.ts abstractions package ([#83](https://github.com/fnioc/ioc/issues/83))

### Features

* **core:** publish @fnioc/core as a pure .d.ts abstractions package ([#83](https://github.com/fnioc/ioc/issues/83)) ([82ab3e7](https://github.com/fnioc/ioc/commit/82ab3e7581db481e0051d30136430a7869a4a0f5))

## [8.0.0](https://github.com/fnioc/ioc/compare/transformer-v6.0.0...transformer-v8.0.0) (2026-07-03)


### ⚠ BREAKING CHANGES

* async resolution + signatures-on-registration (core/di/transformer) ([#82](https://github.com/fnioc/ioc/issues/82))
* the `@signature` class decorator and the `signature` export (from both `@fnioc/core` and `@fnioc/di`) are removed. Author constructor signatures with `forCtor(Class).signature(...)` instead.

### Features

* async resolution + signatures-on-registration (core/di/transformer) ([#82](https://github.com/fnioc/ioc/issues/82)) ([16bd184](https://github.com/fnioc/ioc/commit/16bd1843822767201778616c9f9bfa297f0a1a5c))
* remove the [@signature](https://github.com/signature) class decorator ([#80](https://github.com/fnioc/ioc/issues/80)) ([75a58a2](https://github.com/fnioc/ioc/commit/75a58a222a83d611a4f9ef991056478ee889d266))

## [6.0.0](https://github.com/fnioc/ioc/compare/transformer-v5.0.0...transformer-v6.0.0) (2026-07-02)


### ⚠ BREAKING CHANGES

* closed-generic tokens change token derivation for any generic type reference. Code recompiled with the new transformer re-lowers cleanly; lowered JS published by an older transformer will not unify with new closed tokens for the same generic type.

### Features

* open generics (core/di/transformer) ([#75](https://github.com/fnioc/ioc/issues/75)) ([74930ba](https://github.com/fnioc/ioc/commit/74930baaa404a8a9024657679941c6a320e28dce))

## [5.0.0](https://github.com/fnioc/ioc/compare/transformer-v4.0.0...transformer-v5.0.0) (2026-06-04)


### ⚠ BREAKING CHANGES

* **di:** DiBuilder, DiBuilderClass, and DiBuilderCtor are removed from @fnioc/di. Callers must replace all three with their ServiceManifest-prefixed counterparts.

### Features

* **di:** per-scope add-methods minted from scope tags ([#68](https://github.com/fnioc/ioc/issues/68)) ([aacb897](https://github.com/fnioc/ioc/commit/aacb897e748464754042441e45a87564f0d20246))
* **di:** rename DiBuilder to ServiceManifest ([#72](https://github.com/fnioc/ioc/issues/72)) ([c6b5862](https://github.com/fnioc/ioc/commit/c6b58628d77732f340b9384cee2aeaa1f29329d2))

## [4.0.0](https://github.com/fnioc/ioc/compare/transformer-v3.1.0...transformer-v4.0.0) (2026-06-04)


### ⚠ BREAKING CHANGES

* **di:** DiBuilder<Root, Children> -> DiBuilder<Scopes>; the rootName constructor argument is removed; build() no longer pre-opens a "singleton" root (open it with createScope("singleton")); MissingScopeError is removed and a tagged registration with no open frame now resolves transiently instead of throwing.

### Features

* **di:** uniform scope tags — no pre-opened root frame ([#62](https://github.com/fnioc/ioc/issues/62)) ([ed2f6e2](https://github.com/fnioc/ioc/commit/ed2f6e270673734732bbfd63ffddfdf76f4528f3))

## [3.1.0](https://github.com/fnioc/ioc/compare/transformer-v3.0.1...transformer-v3.1.0) (2026-06-04)


### Features

* tokenize all named types + literal value supply (LiteralRef) ([#51](https://github.com/fnioc/ioc/issues/51)) ([52a70e7](https://github.com/fnioc/ioc/commit/52a70e7ad34d88899c61a85480800260897689ee))
* **transformer:** declared inline-factory args become caller-supplied params ([#59](https://github.com/fnioc/ioc/issues/59)) ([b8f63fb](https://github.com/fnioc/ioc/commit/b8f63fbbd94373404348c5be7b541203f01d2e92))


### Bug Fixes

* **transformer:** preserve Inject brand on optional + union-member params ([#54](https://github.com/fnioc/ioc/issues/54)) ([3ed3878](https://github.com/fnioc/ioc/commit/3ed3878eaa0e3424410efa562f2da65c892f25bd))
* **transformer:** wide-boolean optional + honor all construct overloads on reference paths ([#58](https://github.com/fnioc/ioc/issues/58)) ([648a44e](https://github.com/fnioc/ioc/commit/648a44e5e164770fd11fea831b58ca86d93eb958))

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
