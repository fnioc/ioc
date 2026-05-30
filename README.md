# ioc

**Type-driven, interface-first dependency injection for TypeScript.**

Register against interfaces. No decorators by default. No `reflect-metadata`. No runtime type introspection. A compile-time transformer *lowers* your type-checked DI registrations into plain-data runtime calls — the same relationship as JSX → `createElement` or TypeScript → JavaScript.

> **Status:** In active development — see [`PLAN.md`](PLAN.md) for the implementation roadmap.

---

## The lowering story

You author in a rich, fully type-checked surface. The transformer lowers it to explicit string tokens and positional dep arrays. The runtime engine reads those plain calls and never touches a TypeScript type.

```typescript
// Author code — type-driven, interface-keyed
const services = new DiBuilder<"singleton" | "request">();

services.add<ILogger>(ConsoleLogger).as<"singleton">();
services.add<IUserRepo>(SqlUserRepo).as<"request">();
// SqlUserRepo constructor: (log: ILogger, db: IDbConnection, table: string)
// 'table' is not a registered service — it becomes a hole
```

```typescript
// Lowered output — plain data emitted by the transformer at build time
const services = new DiBuilder();

defineDeps(ConsoleLogger, [[]]);
services.add("pkg:ILogger", ConsoleLogger).as("singleton");

defineDeps(SqlUserRepo, [["pkg:ILogger", "pkg:IDbConnection", null]]);
// null = hole for 'table' (primitive, not a service token)
services.add("pkg:IUserRepo", SqlUserRepo).as("request");
```

The lowered form is the ABI. Libraries compile once with the transformer and publish this output. Every consumer — whether or not they run the transformer — gets the registrations and they work as-is.

---

## Captive-dependency protection

A singleton that depends on a request-scoped service fails **loudly at resolve time**, not silently at runtime after it has captured stale state.

```typescript
const services = new DiBuilder<"singleton" | "request">();

services.add<ICache>(RedisCache).as<"singleton">();
services.add<IUserContext>(HttpUserContext).as<"request">();

// UserService depends on IUserContext — a request-scoped service
services.add<IUserService>(UserService).as<"singleton">();

const root = services.createScope("singleton");
const req  = root.createScope("request");

req.resolve<IUserService>("pkg:IUserService");
// ^ Throws: IUserService is singleton-owned; its deps are resolved relative
//   to the singleton scope. That scope has no "request" ancestor — it throws
//   instead of silently binding one request's IUserContext to every future call.
```

The throw is the feature. Misconfiguration is detected at the first resolve, not discovered weeks later when stale state starts producing wrong results.

---

## Progressive enhancement

The transformer is sugar; the substrate is always usable directly. Three paths for plugin-less consumers:

**`useFactory` / `useValue`** — recommended for overrides and test doubles:

```typescript
container.register("pkg:IDb", {
  useFactory: (c) => new TestDb(c.resolve<IConfig>("pkg:IConfig")),
});

container.register("pkg:ICache", {
  useValue: new NullCache(),
});
```

**`@signature`** — hand-annotate your own classes:

```typescript
@signature("pkg:ILogger", "pkg:IDbConnection", hole)
class SqlUserRepo {
  constructor(log: ILogger, db: IDbConnection, table: string) { ... }
}
```

**`forCtor`** — annotate classes you don't own:

```typescript
forCtor(ThirdPartyService)
  .signature("pkg:IDb")
  .signature("pkg:ILogger", "pkg:IDb"); // second overload
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

```typescript
import { DiBuilder } from "@fnioc/di";

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

const services = new DiBuilder<"singleton">();
services.add<ILogger>(ConsoleLogger).as<"singleton">();
services.add<IGreeter>(Greeter).as<"singleton">();
```

### Create scopes and resolve

```typescript
const root = services.createScope("singleton");

const greeter = root.resolve<IGreeter>("pkg:IGreeter");
greeter.greet("world"); // Hello, world!

// Dispose the scope when the application shuts down
await using _ = root; // uses native Symbol.asyncDispose (TypeScript 5.2+)
```

---

## Packages

| Package | Responsibility |
|---|---|
| [`@fnioc/core`](packages/core) | Immutable substrate: `Token`, `DepRecord`, `ABI_VERSION`, `defineDeps`, `@signature`, `forCtor`, `hole`. The ABI both `di` and `transformer` build on. |
| [`@fnioc/di`](packages/di) | Runtime engine: `DiBuilder<Scopes>`, scope chain, resolution, captive-dependency protection, disposal, `useFactory`/`useValue`. |
| [`@fnioc/transformer`](packages/transformer) | Build-time ts-patch plugin: token derivation, dep extraction, `defineDeps` emission, registration lowering, factory-signature diagnostics. |

```
@fnioc/core ← @fnioc/di
@fnioc/core ← @fnioc/transformer    (di and transformer are independent of each other)
```

---

## Roadmap

**Factory injection** (Phase 2D) — constructor parameters typed as arrow functions returning a registered interface are injected as factories, not instances. Partial/positional factories — where the factory's call signature covers only the unregistered parameters — are designed and coming.

```typescript
// Designed, not yet implemented
class RequestHandler {
  constructor(
    private log: ILogger,         // resolved normally
    private makeConn: () => IDb,  // injected as a factory
  ) {}

  handle() {
    const db = this.makeConn(); // fresh IDb per call
    // ...
  }
}
```

Other planned additions: `@fnioc/eslint-plugin` (factory-signature diagnostics in-editor), an `unplugin` wrapper (Vite/Rollup/esbuild/webpack), and DI-aware testing utilities.

---

## Reference

- [Design document](PRD.md)
- [`@fnioc/di` — runtime engine](packages/di/README.md)
- [`@fnioc/core` — ABI substrate](packages/core/README.md)
- [`@fnioc/transformer` — build-time plugin](packages/transformer/README.md)

## License

MIT © Thomas Butler
