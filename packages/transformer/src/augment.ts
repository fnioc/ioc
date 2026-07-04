// Type-only authoring surface contributed to `@fnioc/di` by the transformer.
//
// These generic, token-free forms (`add<I>(C)`, `add<I>(fn)`, `addValue<I>(v)`,
// `.as<"scope">()`, `resolve<T>()`) NEVER execute: the @fnioc/transformer
// rewrites every such call to its explicit-token / value-arg form before
// runtime. They are therefore PURE TYPINGS, and they live here rather than in
// di's published types so that the authoring surface lights up only when the
// transformer is in the TypeScript program. Without the transformer, these
// forms don't exist on di's surface — which is the truth at runtime tool-free,
// and which kills the "compiles but throws at runtime" footgun.
//
// This module must be reachable from @fnioc/transformer's published types entry
// (it is `import`ed for its side effect from `./index.ts`) so that a consumer
// referencing `@fnioc/transformer` pulls the augmentation into its program.

import type { Ctor, Func } from "@rhombus-toolkit/func";
// Side-effect type import: makes @fnioc/di a known module in this program so
// the `declare module "@fnioc/di"` block below is treated as an augmentation
// (extending the package's types) rather than an ambient module declaration.
// No symbols are imported — the import exists solely to anchor the augmentation.
import type {} from "@fnioc/di";

// Re-export the authoring brand types so transformer consumers can use
// `Inject<T, "tok">`, the open-generics placeholders (`Hole<N, C>`, `$<N>`)
// and the `Typeof<T>` witness without importing from `@fnioc/core`
// directly. The overload-faithful `OverloadedParameters` / `OverloadedConstructorParameters`
// ride along too — they type a factory rest parameter so an overloaded ctor
// lowers to one dep signature per overload. A single import of
// `@fnioc/transformer` brings both the transformer plugin and these types into scope.
export type {
  Inject,
  Hole,
  $,
  Typeof,
  OverloadedParameters,
  OverloadedConstructorParameters,
} from "@fnioc/core";

declare module "@fnioc/di" {
  // The authoring forms merge onto the IMPLEMENTATION class `ServiceManifestClass`
  // (the public `ServiceManifest` is now a type alias `ServiceManifestClass<S> &
  // ScopeAddMethods<S>`, which an interface cannot merge into). The alias picks
  // these up through its `ServiceManifestClass<S>` arm.
  interface ServiceManifestClass<Scopes extends string = "singleton"> {
    /**
     * Type-driven class authoring — lowers to `add("token", C)`. The ctor is
     * typed `Ctor<any[], I>` (a plain construct signature, so an abstract class
     * is rejected). Never runs post-transform.
     *
     * A GENERIC impl is authored as an instantiation expression —
     * `add<IRepo<$<1>>>(SqlRepository<$<1>>)` (open template) or
     * `add<IRepo<User>>(SqlRepository<User>)` (closed) — and lowers to
     * `add("token", C, signatures)` with its dep signatures carried on the
     * registration (type args stripped from the emitted ctor).
     */
    add<I>(ctor: Ctor<any[], I>): AddBuilder<Scopes>;
    /**
     * Registration-time override form — a sparse positional override array for a
     * class whose ctor you can't edit (third-party / generic). Each element
     * overrides the transformer-derived token at that position; `undefined` (or
     * an array hole) keeps the derived token. Lowers to
     * `add("token", C, [[...merged...]])`. Never runs post-transform.
     *
     *   add<ICache>(RedisCache, ["pkg:IRedisClient", undefined, "pkg:ILogger"])
     */
    add<I>(
      ctor: Ctor<any[], I>,
      overrides: readonly (string | undefined)[],
    ): AddBuilder<Scopes>;
    /**
     * Type-driven factory authoring — lowers to `addFactory("token", fn)` (the
     * transformer knows the arg is a function). Never runs post-transform.
     */
    add<I>(factory: Func<any[], I>): AddBuilder<Scopes>;
    /**
     * Type-driven value authoring — lowers to `addValue("token", v)`. Never runs
     * post-transform.
     */
    addValue<I>(value: I): void;
  }

  // The AUTHORED single-arg per-scope forms. `ScopeAddMethods<S>` mints each
  // `add${ProperCase<K>}` as `((token, ctor) => void) & ScopeAddAuthoring<S, K>`;
  // augmenting the empty carrier here adds the token-free authoring overloads, so
  // `addRequest(C)` / `addRequest(fn)` type-check ONLY with the transformer in the
  // program. Each lowers to its two-arg runtime form + the baked-in scope — there
  // is no `.as()` continuation, so both return `void`.
  interface ScopeAddAuthoring<S extends string, K extends S> {
    /**
     * Authored class form — `addRequest(C)` lowers to `add("token", C).as("request")`.
     * Mirrors `add<I>(ctor)`, with the scope baked into the method name.
     */
    <I>(ctor: Ctor<any[], I>): void;
    /**
     * Authored factory form — `addRequest(fn)` lowers to
     * `addFactory("token", fn).as("request")`. Mirrors `add<I>(factory)`.
     */
    <I>(factory: Func<any[], I>): void;
  }

  interface AddBuilder<Scopes extends string> {
    /**
     * The AUTHORED lifetime form — `.as<"singleton">()`. The scope name is a
     * TYPE argument; the `S extends Scopes` bound is the compile-time
     * captive-misconfiguration guard. The transformer rewrites it to the
     * value-arg `.as("singleton")` before it runs.
     */
    as<S extends Scopes>(): void;
  }

  interface Resolver {
    /**
     * Tokenless authored resolve — `resolve<IFoo>()`. The transformer lowers it
     * to an explicit-token `resolve("token")` (or `resolveFactory` for a
     * function-typed arg) before runtime.
     */
    resolve<T>(): T;
    /**
     * Tokenless authored factory resolve — `resolve<(a: A, b: B) => T>()`. The
     * transformer lowers it to `resolveFactory("T-token", ["A-token", "B-token"])`.
     * Zero-param form `resolve<() => T>()` lowers to `resolveFactory("T-token")`.
     * Never runs post-transform.
     */
    resolve<F extends (...args: any[]) => any>(): ReturnType<F>;
  }

  // A class does NOT inherit interface overloads, so `sp.resolve<I>()` needs
  // the tokenless form merged onto the `ServiceProvider` class itself, not just
  // the structural `Resolver` it implements.
  interface ServiceProvider<S extends string> {
    resolve<T>(): T;
    resolve<F extends (...args: any[]) => any>(): ReturnType<F>;
  }
}
