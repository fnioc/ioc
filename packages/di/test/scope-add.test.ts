import { test, expect, describe } from "bun:test";
import { ServiceManifest, ServiceManifestClass } from "@fnioc/di";
import { T } from "./fixtures.js";

// Per-scope `add${ProperCase<K>}` runtime dispatch. The methods are minted by a
// Proxy at the END of `ServiceManifestClass`'s prototype chain, so they never shadow
// the real `add` / `addFactory` / `addValue` / `build` members, and unknown
// non-add lookups fall through to `Object.prototype` exactly as before.
//
// At runtime only the two-arg `(token, ctor)` form executes — `addSingleton(C)`
// is an authoring form the @fnioc/transformer lowers, so calling it directly
// (single arg) is a misuse that fails loud, mirroring `add()`.

// `addSingleton` is a runtime-minted method; the static type only exposes the
// authored single-arg form when the transformer is in the program. These tests
// run plugin-less, so reach the two-arg runtime form through a cast.
interface RuntimeAdd {
  addSingleton(token: string, ctor: new (...a: never[]) => unknown): void;
  addRequest(token: string, ctor: new (...a: never[]) => unknown): void;
}
function runtime(b: unknown): RuntimeAdd {
  return b as RuntimeAdd;
}

class Logger {
  public readonly id = Symbol("logger");
}

describe("per-scope addSingleton runtime", () => {
  test("addSingleton(token, C) registers + caches in an open singleton frame", () => {
    const services = new ServiceManifest<"singleton">();
    runtime(services).addSingleton(T.Logger, Logger);

    const app = services.build().createScope("singleton");
    const a = app.resolve<Logger>(T.Logger);
    const b = app.resolve<Logger>(T.Logger);
    expect(a).toBeInstanceOf(Logger);
    expect(a).toBe(b); // cached in the singleton frame
  });

  test("no matching frame open → transient (fresh instance, no cache, NO error)", () => {
    const services = new ServiceManifest<"singleton">();
    runtime(services).addSingleton(T.Logger, Logger);

    // Build a frameless provider — the singleton frame is never opened.
    const provider = services.build();
    const a = provider.resolve<Logger>(T.Logger);
    const b = provider.resolve<Logger>(T.Logger);
    expect(a).toBeInstanceOf(Logger);
    expect(b).toBeInstanceOf(Logger);
    expect(a).not.toBe(b); // transient: a fresh instance per resolve, no throw
  });

  test("addRequest tags the request scope (caches only when request is open)", () => {
    const services = new ServiceManifest<"singleton" | "request">();
    runtime(services).addRequest(T.Logger, Logger);

    const root = services.build().createScope("singleton");
    const req = root.createScope("request");
    const a = req.resolve<Logger>(T.Logger);
    const b = req.resolve<Logger>(T.Logger);
    expect(a).toBe(b); // cached in the request frame

    // No request frame open (only singleton) → transient.
    const c = root.resolve<Logger>(T.Logger);
    const d = root.resolve<Logger>(T.Logger);
    expect(c).not.toBe(d);
  });
});

describe("the proxy does not disturb existing surfaces", () => {
  test("add / addFactory / addValue / build are unaffected (own methods, not trapped)", () => {
    const services = new ServiceManifest<"singleton">();
    services.add(T.Logger, Logger).as("singleton");
    services.addFactory(T.Service, () => new Logger()).as("singleton");
    services.addValue(T.Db, { kind: "db" });
    const app = services.build().createScope("singleton");
    expect(app.resolve<Logger>(T.Logger)).toBeInstanceOf(Logger);
    expect(app.resolve<Logger>(T.Service)).toBeInstanceOf(Logger);
    expect(app.resolve<{ kind: string }>(T.Db).kind).toBe("db");
  });

  test("an unknown non-add property resolves normally (undefined, not trapped)", () => {
    const services = new ServiceManifest<"singleton">();
    // `address` starts with "add" but the 4th char is lowercase → NOT /^add[A-Z]/.
    expect((services as unknown as Record<string, unknown>).address).toBeUndefined();
    expect((services as unknown as Record<string, unknown>).additional).toBeUndefined();
  });

  test("awaiting the builder does not hang on a synthetic `then` trap", async () => {
    const services = new ServiceManifest<"singleton">();
    // A bogus `then` would make `await` treat the builder as a thenable and hang.
    // `then` is lowercase-`t` → not a scope-add method, so the proxy returns the
    // Object.prototype miss (undefined), and await resolves with the value.
    const resolved = await Promise.resolve(services);
    expect(resolved).toBe(services);
  });

  test("instanceof ServiceManifestClass holds (prototype identity preserved)", () => {
    expect(new ServiceManifest<"singleton">()).toBeInstanceOf(ServiceManifestClass);
  });
});

describe("plugin-less misuse fails loud", () => {
  test("a single-arg authored call throws TypeError naming the transformer", () => {
    const services = new ServiceManifest<"singleton">();
    expect(() =>
      (services as unknown as { addSingleton(c: unknown): void }).addSingleton(
        Logger,
      ),
    ).toThrow(TypeError);
  });

  test("a non-string first arg throws TypeError (same guard as add())", () => {
    const services = new ServiceManifest<"singleton">();
    expect(() =>
      (
        services as unknown as { addSingleton(a: unknown, b: unknown): void }
      ).addSingleton(Logger, "t:logger"),
    ).toThrow(TypeError);
  });
});
