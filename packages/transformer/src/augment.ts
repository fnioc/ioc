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

import type { AddBuilder } from "@fnioc/di";

declare module "@fnioc/di" {
  interface DiBuilder<Root extends string, Children extends string> {
    /**
     * Type-driven class authoring — lowers to `add("token", C)`. The ctor is
     * typed `Ctor<any[], I>` (a plain construct signature, so an abstract class
     * is rejected). Never runs post-transform.
     */
    add<I>(ctor: Ctor<any[], I>): AddBuilder<Root | Children>;
    /**
     * Type-driven factory authoring — lowers to `addFactory("token", fn)` (the
     * transformer knows the arg is a function). Never runs post-transform.
     */
    add<I>(factory: Func<any[], I>): AddBuilder<Root | Children>;
    /**
     * Type-driven value authoring — lowers to `addValue("token", v)`. Never runs
     * post-transform.
     */
    addValue<I>(value: I): void;
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
  }

  // A class does NOT inherit interface overloads, so `sp.resolve<I>()` needs
  // the tokenless form merged onto the `ServiceProvider` class itself, not just
  // the structural `Resolver` it implements.
  interface ServiceProvider<S extends string> {
    resolve<T>(): T;
  }
}
