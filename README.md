# ioc

**Type-driven, interface-first dependency injection for TypeScript.**

Register against interfaces. No decorators by default. No `reflect-metadata`. No runtime type introspection. A compile-time transformer *lowers* your type-checked DI registrations into plain-data runtime calls — the same relationship as JSX → `createElement` or TypeScript → JavaScript.

> **Status:** In active development — see [`PLAN.md`](PLAN.md) for the implementation roadmap.

---

## The lowering story

You author in a rich, fully type-checked surface. The transformer lowers it to explicit string tokens and positional dep arrays. The runtime engine reads those plain calls and never touches a TypeScript type.

```ts
// Author code — type-driven, interface-keyed
const services = new ServiceManifest<"singleton" | "request">();

services.add<ILogger>(ConsoleLogger).as<"singleton">();
services.add<IUserRepo>(SqlUserRepo).as<"request">();
// SqlUserRepo constructor: (log: ILogger, db: IDbConnection, table: string)
// 'table' has type string → token "string" (runtime miss if "string" is unregistered)
// use Inject<string, "app:tableName"> to pin a custom token, or supply a signature override
```

```ts
// Lowered output — plain data emitted by the transformer at build time
const services = new ServiceManifest();

defineDeps(ConsoleLogger, [[]]);
services.add("pkg:ILogger", ConsoleLogger).as("singleton");

defineDeps(SqlUserRepo, [["pkg:ILogger", "pkg:IDbConnection", "app:tableName"]]);
services.add("pkg:IUserRepo", SqlUserRepo).as("request");
```

The lowered form is the ABI. Libraries compile once with the transformer and publish this output. Every consumer — whether or not they run the transformer — gets the registrations and they work as-is.

---

## Open generics

Closing a generic is the same trick, one level up — token algebra, not runtime type machinery. TypeScript generics are erased: there is exactly ONE JS class per generic implementation, so a "closing" needs no reflection. Register once against a placeholder-typed interface using `$<N>`/`Hole<N>` skolems on both sides:

```ts
// Author code — $<1> stands in for IRepository's type parameter on both sides
interface IRepository<T> { find(id: string): Promise<T>; }

class SqlRepository<T> implements IRepository<T> {
  constructor(private db: IDbConnection, private entityToken: Typeof<T>) {}
}

services.add<IRepository<$<1>>>(SqlRepository<$<1>>).as<"singleton">();

// Distinct closings resolve to distinct, independently-cached instances
const userRepo = scope.resolve<IRepository<User>>();
const orderRepo = scope.resolve<IRepository<Order>>();
```

The transformer lowers this to a **template token** carrying the constructor's dep signature on the registration itself, not the usual ctor-keyed `defineDeps` (one open impl can back many closings, so the metadata can't live on the shared ctor object):

```ts
// Lowered output
services.add("pkg:IRepository<$1>", SqlRepository, [
  ["pkg:IDbConnection", { typeArg: 1 }],
]);
```

**The erasure insight.** Because every closing shares the same JS class, the runtime never instantiates a generic — it derives the right *string*. `IRepository<User>` and `IRepository<Order>` are two ordinary, distinct-cache-key tokens (`pkg:IRepository<pkg:User>`, `pkg:IRepository<pkg:Order>`) that happen to share a base and an implementation. Resolving one parses the token, matches it against the open registration by base + arity, substitutes `$1` → `pkg:User` through the carried dep signature, and caches the result as a synthesized, perfectly ordinary registration from then on. See [`@fnioc/di`](packages/di/README.md#open-generics) for the resolution mechanics and [`@fnioc/transformer`](packages/transformer/README.md#open-generics) for the full closed-token grammar, instantiation expressions, and diagnostics.

---

## Design philosophy — scopes are uniform tags

**Scopes are uniform tags — there is no root.** `"singleton"` is literally just a tag you happen to open once at the top. You can run the container without ever opening a scope at all; with no matching frame open, resolution is transient.

`build()` returns a frameless provider — nothing is pre-opened. A lifetime tag caches its instance in the nearest enclosing **open** frame carrying that tag; with no such frame open it resolves transiently (fresh, no cache, no error). Open a frame with `createScope(name)` when you want a tag to cache — `"singleton"` included. This is the central organizing principle of the runtime.

---

## Captive-dependency protection

A singleton can never **cache-capture** a shorter-lived service. Its dependencies resolve relative to the frame that *owns* it, so when a request-scoped dependency has no enclosing request frame, it resolves to a **fresh transient** — never a stale request instance bound for the singleton's whole life.

```ts
const services = new ServiceManifest<"singleton" | "request">();

services.add<ICache>(RedisCache).as<"singleton">();
services.add<IUserContext>(HttpUserContext).as<"request">();

// UserService depends on IUserContext — a request-scoped service
services.add<IUserService>(UserService).as<"singleton">();

const app = services.build().createScope("singleton");
const req = app.createScope("request");

req.resolve<IUserService>("pkg:IUserService");
// ^ UserService is singleton-owned; its deps resolve relative to the singleton
//   frame, which has no ENCLOSING "request" frame (request is a descendant). So
//   IUserContext resolves to a FRESH transient — never one request's instance
//   bound to every future call.
```

The fresh transient is the safe outcome. The construct-relative-to-owner rule makes cache-capture structurally impossible, with no misconfiguration to discover weeks later.

---

## Progressive enhancement

The transformer is sugar; the substrate is always usable directly. Three paths for plugin-less consumers:

**`useFactory` / `useValue`** — recommended for overrides and test doubles:

```ts
services.add("pkg:IDb", {
  useFactory: (c) => new TestDb(c.resolve<IConfig>("pkg:IConfig")),
});

services.add("pkg:ICache", {
  useValue: new NullCache(),
});
```

**`forCtor`** — hand-annotate your own classes or classes you don't own:

```ts
forCtor(SqlUserRepo)
  .signature("pkg:ILogger", "pkg:IDbConnection");

forCtor(ThirdPartyService)
  .signature("pkg:IDb")
  .signature("pkg:ILogger", "pkg:IDb");
```

**Registration-time override** — sparse override for third-party or generic classes when you have the transformer but can't edit the ctor:

```ts
// Override specific positions; undefined keeps the transformer-generated token
services.add<ICache>(RedisCache, ["pkg:IRedisClient", undefined, "pkg:ILogger"]);
```

---

## Quick start

### Install

```sh
npm install @fnioc/di @fnioc/core
# transformer is a build-time dev dependency
npm install --save-dev @fnioc/transformer ts-patch
```

### Wire the transformer

```json
// tsconfig.json
{
  "compilerOptions": {
    "plugins": [{ "transform": "@fnioc/transformer" }]
  }
}
```

Run `ts-patch install` once in your project to patch the TypeScript compiler. Then use `tspc` (from ts-patch) instead of `tsc` in your build script.

### Register services

```ts
import { ServiceManifest } from "@fnioc/di";

interface ILogger { log(msg: string): void; }
interface IGreeter { greet(name: string): string; }

class ConsoleLogger implements ILogger {
  log(msg: string) { console.log(msg); }
}

class Greeter implements IGreeter {
  constructor(private log: ILogger) {}
  greet(name: string) {
    this.log.log(`greeting ${name}`);
    return `Hello, ${name}!`;
  }
}

const services = new ServiceManifest<"singleton">();
services.add<ILogger>(ConsoleLogger).as<"singleton">();
services.add<IGreeter>(Greeter).as<"singleton">();
```

### Create scopes and resolve

```ts
// build() is frameless — open the "singleton" scope so singletons cache.
const root = services.build().createScope("singleton");

const greeter = root.resolve<IGreeter>("pkg:IGreeter");
greeter.greet("world"); // Hello, world!

// Dispose the scope when the application shuts down
await using _ = root; // uses native Symbol.asyncDispose (TypeScript 5.2+)
```

---

## Packages

| Package | Responsibility |
|---|---|
| [`@fnioc/core`](packages/core) | Immutable substrate: `Token`, `DepSlot`, `FactoryRef`, `ScopeRef`, `Union`, `union`, `Inject`, `defineDeps`, `forCtor`, plus the open-generics grammar (`Hole`, `$`, `Typeof`, `closeToken`, `parseToken`, `isOpenToken`, `substituteToken`). The ABI both `di` and `transformer` build on. |
| [`@fnioc/di`](packages/di) | Runtime engine: `ServiceManifest<Scopes>`, uniform scope tags, frameless `build()`, resolution with transient fallback, captive-dependency protection, disposal, `useFactory`/`useValue`. Re-exports the `@fnioc/core` authoring surfaces. |
| [`@fnioc/transformer`](packages/transformer) | Build-time ts-patch plugin: token derivation, dep extraction, `defineDeps` emission, registration lowering, factory-signature diagnostics. Re-exports `Inject`. |

```
@fnioc/core ← @fnioc/di
@fnioc/core ← @fnioc/transformer    (di and transformer are independent of each other)
```

---

## Factory injection

Constructor parameters typed as inline arrow or function types returning a registered interface are injected as callables rather than resolved instances. The factory's call signature exposes only the target constructor's caller-supplied parameters, in order — registered deps are resolved by the container at call time.

```ts
class RequestHandler {
  constructor(
    private log: ILogger,         // resolved normally
    private makeConn: () => IDb,  // injected as a factory
  ) {}

  handle() {
    const db = this.makeConn(); // builds an IDb on demand
    // ...
  }
}
```

Named callable interfaces opt out of factory interpretation and resolve as normal services. The transformer validates factory signatures at compile time (see [`@fnioc/transformer`](packages/transformer/README.md)).

---

## Union deps and `Inject`

Two new slot kinds let you express alternatives and per-arg token overrides directly in the type system:

**`Union`** — tried in declaration order, first registered wins:

```ts
// Inline union annotation → lowered to a Union slot automatically
class Handler {
  constructor(cache: IRedis | IMemoryCache, log: ILogger) {}
}
// Register at least one of IRedis or IMemoryCache; the first registered wins.
```

**`Inject<T, K>`** — pin a specific token for one arg without changing the value type:

```ts
import type { Inject } from "@fnioc/transformer";

class Handler {
  constructor(
    cache: Inject<ICache, "pkg:redis-cache">,
    log: ILogger,
  ) {}
}
```

Both are zero-runtime and work in any type position the transformer reads.

---

## Roadmap

Planned additions: `@fnioc/eslint-plugin` (factory-signature diagnostics in-editor), an `unplugin` wrapper (Vite/Rollup/esbuild/webpack), and DI-aware testing utilities.

---

## Workspace development

In the workspace, `@fnioc/core` and `@fnioc/di` resolve to their TypeScript source (`./src/index.ts`) — no build step is needed after editing either package for changes to be visible in dependents. Bun executes TypeScript natively; tsc and IDEs follow the `source`/`bun`/`types` export conditions to the same source file.

`@fnioc/transformer` remains dist-pointing because ts-patch loads it via Node `require()`, which cannot execute TypeScript source.

Published tarballs carry dist-pointing manifests. `pnpm pack` applies the `publishConfig` overrides in each package's `package.json`, rewriting `main`/`types`/`exports` to the built `dist/` values and resolving `workspace:*` deps to concrete semver ranges before the tarball is created.

## Reference

- [Design document](PRD.md)
- [`@fnioc/di` — runtime engine](packages/di/README.md)
- [`@fnioc/core` — ABI substrate](packages/core/README.md)
- [`@fnioc/transformer` — build-time plugin](packages/transformer/README.md)

## License

MIT © Thomas Butler
