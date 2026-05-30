import { test, expect, describe } from "bun:test";
import {
  DiBuilder,
  MissingScopeError,
  UnregisteredTokenError,
} from "@fnioc/di";
import { defineDeps } from "@fnioc/core";
import { T } from "./fixtures.js";

// Scope chain + hierarchical lookup, child-shadows-parent override, the
// captive-dependency throw, and THE critical rule (§"construct relative to the
// owning scope").

class RealDb {
  public readonly kind = "real";
}
class FakeDb {
  public readonly kind = "fake";
}

describe("scope chain + child-shadows-parent override", () => {
  test("a child-scope override shadows the builder's base registration", () => {
    const services = new DiBuilder<"singleton" | "request">();
    services.add(T.Db, RealDb).as("request");

    const root = services.createScope("singleton");
    const req = root.createScope("request");
    // Local override on the request scope: a fake DB just for this subtree.
    req.registerValue(T.Db, new FakeDb());

    const resolved = req.resolve<RealDb | FakeDb>(T.Db);
    expect(resolved.kind).toBe("fake");
  });

  test("a parent override is shadowed by a nearer child override", () => {
    const services = new DiBuilder<"singleton" | "request">();
    services.add(T.Db, RealDb).as("request");

    const root = services.createScope("singleton");
    root.registerValue(T.Db, new FakeDb()); // override at root...
    const req = root.createScope("request");
    const realInstance = new RealDb();
    req.registerValue(T.Db, realInstance); // ...shadowed nearer the leaf

    expect(req.resolve<RealDb>(T.Db)).toBe(realInstance);
    expect(root.resolve<FakeDb>(T.Db).kind).toBe("fake");
  });

  test("lookup falls through to the builder base map when no local override", () => {
    const services = new DiBuilder<"singleton" | "request">();
    services.add(T.Db, RealDb).as("singleton");

    const root = services.createScope("singleton");
    const req = root.createScope("request");

    // No override anywhere in req's locals — resolves through to the base map,
    // owned by the singleton ancestor.
    const fromReq = req.resolve<RealDb>(T.Db);
    const fromRoot = root.resolve<RealDb>(T.Db);
    expect(fromReq).toBe(fromRoot);
  });

  test("resolving an unregistered token throws UnregisteredTokenError", () => {
    const services = new DiBuilder<"singleton">();
    const root = services.createScope("singleton");
    expect(() => root.resolve(T.Db)).toThrow(UnregisteredTokenError);
  });
});

describe("captive-dependency protection", () => {
  // A "singleton" service depends on a "request" service. The singleton owns
  // its instance; its deps resolve relative to the singleton scope's chain,
  // which has no "request" ancestor ⇒ throw. The singleton must never silently
  // capture one request's instance and hold it forever.
  class RequestScoped {
    public readonly kind = "request-scoped";
  }
  class SingletonNeedingRequest {
    public constructor(public readonly reqDep: RequestScoped) {}
  }

  test("singleton depending on request throws MissingScopeError (§5.4)", () => {
    const services = new DiBuilder<"singleton" | "request">();
    defineDeps(SingletonNeedingRequest, [[T.Service]]);
    services.add(T.Service, RequestScoped).as("request");
    services.add(T.Repo, SingletonNeedingRequest).as("singleton");

    const root = services.createScope("singleton");
    const req = root.createScope("request");

    // Triggered FROM the request scope (which DOES have a request ancestor),
    // but the singleton owns SingletonNeedingRequest, so its dep on the
    // request service is resolved relative to the singleton's chain — no
    // request ancestor there ⇒ throw. This is the whole point.
    expect(() => req.resolve(T.Repo)).toThrow(MissingScopeError);
  });

  test("the MissingScopeError names the offending token and tag", () => {
    const services = new DiBuilder<"singleton" | "request">();
    defineDeps(SingletonNeedingRequest, [[T.Service]]);
    services.add(T.Service, RequestScoped).as("request");
    services.add(T.Repo, SingletonNeedingRequest).as("singleton");

    const req = services.createScope("singleton").createScope("request");
    try {
      req.resolve(T.Repo);
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingScopeError);
      const e = err as MissingScopeError;
      expect(e.token).toBe(T.Service);
      expect(e.tag).toBe("request");
    }
  });

  test("a tag with NO matching ancestor anywhere throws MissingScopeError", () => {
    const services = new DiBuilder<"singleton" | "request" | "transaction">();
    services.add(T.Db, RealDb).as("transaction"); // never created

    const root = services.createScope("singleton");
    const req = root.createScope("request");

    // "transaction" scope is never minted — must throw, never auto-create.
    expect(() => req.resolve(T.Db)).toThrow(MissingScopeError);
  });
});

describe("THE critical rule — construct relative to the owning scope", () => {
  // request → singleton. The reverse of the captive case: a request-scoped
  // service depending on a singleton resolves fine, and the singleton is shared
  // across requests because it is owned by the (shared) singleton ancestor.
  class Singleton {
    public readonly id = Math.random();
  }
  class RequestService {
    public constructor(public readonly shared: Singleton) {}
  }

  test("request service depending on singleton gets the shared singleton", () => {
    const services = new DiBuilder<"singleton" | "request">();
    defineDeps(RequestService, [[T.Logger]]);
    services.add(T.Logger, Singleton).as("singleton");
    services.add(T.Service, RequestService).as("request");

    const root = services.createScope("singleton");
    const reqA = root.createScope("request");
    const reqB = root.createScope("request");

    const a = reqA.resolve<RequestService>(T.Service);
    const b = reqB.resolve<RequestService>(T.Service);

    expect(a).not.toBe(b); // distinct request services
    expect(a.shared).toBe(b.shared); // ...sharing ONE singleton dep
  });

  test("a singleton's deps resolve from the singleton scope, not the trigger", () => {
    // Singleton A depends on singleton B. Both owned by root. Resolving A from a
    // deep child still constructs B relative to root, and B is cached on root.
    class B {
      public readonly id = "B";
    }
    class A {
      public constructor(public readonly b: B) {}
    }
    const services = new DiBuilder<"singleton" | "request">();
    defineDeps(A, [[T.B]]);
    services.add(T.B, B).as("singleton");
    services.add(T.A, A).as("singleton");

    const root = services.createScope("singleton");
    const deepChild = root.createScope("request").createScope("request");

    const a = deepChild.resolve<A>(T.A);
    const bDirect = root.resolve<B>(T.B);

    // B was constructed during A's resolution and cached on ROOT — resolving B
    // directly from root returns that same cached instance.
    expect(a.b).toBe(bDirect);
  });
});
