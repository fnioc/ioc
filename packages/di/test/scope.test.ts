import { test, expect, describe } from "bun:test";
import {
  ServiceManifest,
  UnregisteredTokenError,
} from "@fnioc/di";
import { defineDeps } from "@fnioc/core";
import { T } from "./fixtures.js";

// ServiceProvider / Scope chain + hierarchical lookup, transient fallback when
// no matching frame is open, and THE critical rule (§"construct relative to the
// owning scope"). Scope-local registration was removed in the container
// redesign — all registrations are sealed on ServiceManifest.build().

class RealDb {
  public readonly kind = "real";
}
class FakeDb {
  public readonly kind = "fake";
}

describe("scope chain + sealed registration lookup", () => {
  test("a later builder registration shadows the earlier one (last-wins)", () => {
    const services = new ServiceManifest<"singleton" | "request">();
    services.add(T.Db, RealDb).as("request");
    services.addValue(T.Db, new FakeDb());

    const root = services.build();
    const req = root.createScope("request");

    // addValue was registered last — it wins across all scopes.
    const resolved = req.resolve<RealDb | FakeDb>(T.Db);
    expect(resolved.kind).toBe("fake");
  });

  test("lookup falls through to the builder base map when no override", () => {
    const services = new ServiceManifest<"singleton" | "request">();
    services.add(T.Db, RealDb).as("singleton");

    const root = services.build().createScope("singleton");
    const req = root.createScope("request");

    // No override anywhere — resolves through to the base map, cached on the
    // enclosing singleton frame and shared between the singleton scope and its
    // request child.
    const fromReq = req.resolve<RealDb>(T.Db);
    const fromRoot = root.resolve<RealDb>(T.Db);
    expect(fromReq).toBe(fromRoot);
  });

  test("resolving an unregistered token throws UnregisteredTokenError", () => {
    const services = new ServiceManifest<"singleton">();
    const root = services.build();
    expect(() => root.resolve(T.Db)).toThrow(UnregisteredTokenError);
  });

  test("SEAL-ON-BUILD: builder mutations after build() do not affect the root", () => {
    const services = new ServiceManifest<"singleton">();
    services.add(T.Db, RealDb).as("singleton");
    const root = services.build();

    // Adding a new registration after build() must not leak into the sealed map.
    services.addValue(T.Db, new FakeDb());

    // The root still resolves the original class registration.
    const resolved = root.resolve<RealDb | FakeDb>(T.Db);
    expect(resolved.kind).toBe("real");
    expect(resolved).toBeInstanceOf(RealDb);
  });
});

describe("no open frame ⇒ transient (uniform-tag fallback)", () => {
  // A tagged registration whose frame is not open resolves transiently — a
  // fresh instance, no cache, no error. The construct-relative-to-owner rule
  // still holds, so a longer-lived service never CACHE-captures a shorter-lived
  // dep: with no enclosing frame for that dep, it gets a fresh transient.
  class RequestScoped {
    public readonly kind = "request-scoped";
  }
  class SingletonNeedingRequest {
    public constructor(public readonly reqDep: RequestScoped) {}
  }

  test("(a) provider-level resolve with no scope open ⇒ fresh instance per call, even for 'singleton'-tagged", () => {
    const services = new ServiceManifest<"singleton">();
    services.add(T.Service, RequestScoped).as("singleton");

    const provider = services.build(); // frameless

    // No "singleton" frame open ⇒ transient: a fresh instance every resolve.
    expect(provider.resolve(T.Service)).not.toBe(provider.resolve(T.Service));
  });

  test("(b) a 'singleton'-tagged dep resolved inside only a 'request' frame ⇒ transient", () => {
    const services = new ServiceManifest<"singleton" | "request">();
    defineDeps(SingletonNeedingRequest, [[T.Service]]);
    services.add(T.Service, RequestScoped).as("request");
    services.add(T.Repo, SingletonNeedingRequest).as("singleton");

    // Open ONLY a request frame (no enclosing singleton).
    const req = services.build().createScope("request");

    // SingletonNeedingRequest is "singleton"-tagged but no singleton frame is
    // open ⇒ it resolves transiently. Its "request"-tagged dep IS enclosed by
    // the open request frame, so the dep caches there. No throw anywhere.
    const a = req.resolve<SingletonNeedingRequest>(T.Repo);
    const b = req.resolve<SingletonNeedingRequest>(T.Repo);
    expect(a).not.toBe(b); // the singleton-tagged holder is transient here
    expect(a.reqDep).toBeInstanceOf(RequestScoped);
    expect(a.reqDep).toBe(b.reqDep); // ...but the request dep caches in the open request frame
  });

  test("the construct-relative-to-owner rule prevents cache-capture: a 'singleton' owner gets a FRESH request dep", () => {
    // singleton frame open AND a request child open. A singleton-owned service
    // depends on a request-scoped service. The singleton owner's chain has no
    // ENCLOSING request frame (request is a descendant), so the dep resolves
    // transiently — the singleton never captures the request's cached instance.
    class SingletonHolder {
      public constructor(public readonly reqDep: RequestScoped) {}
    }
    const services = new ServiceManifest<"singleton" | "request">();
    defineDeps(SingletonHolder, [[T.Service]]);
    services.add(T.Service, RequestScoped).as("request");
    services.add(T.Repo, SingletonHolder).as("singleton");

    const root = services.build().createScope("singleton");
    const req = root.createScope("request");

    // Resolved from the request scope, but the singleton owns SingletonHolder,
    // so its request dep resolves relative to the singleton frame — no enclosing
    // request frame there ⇒ a fresh transient, not the request's cached instance.
    const holder = req.resolve<SingletonHolder>(T.Repo);
    expect(holder.reqDep).toBeInstanceOf(RequestScoped);
    expect(holder.reqDep).not.toBe(req.resolve(T.Service)); // NOT cache-captured
  });

  test("a tag whose frame is never opened anywhere ⇒ transient (never auto-created)", () => {
    const services = new ServiceManifest<"singleton" | "request" | "transaction">();
    services.add(T.Db, RealDb).as("transaction"); // never opened

    const root = services.build().createScope("singleton");
    const req = root.createScope("request");

    // "transaction" is never opened — resolves transiently, fresh each time.
    expect(req.resolve(T.Db)).not.toBe(req.resolve(T.Db));
    expect(req.resolve(T.Db)).toBeInstanceOf(RealDb);
  });
});

describe("THE critical rule — construct relative to the owning scope", () => {
  // request → singleton. A request-scoped service depending on a singleton
  // resolves fine, and the singleton is shared across requests because it is
  // owned by the (shared) enclosing singleton frame.
  class Singleton {
    public readonly id = Math.random();
  }
  class RequestService {
    public constructor(public readonly shared: Singleton) {}
  }

  test("(c) nearest-frame caching works when the right frame is open — shared singleton across requests", () => {
    const services = new ServiceManifest<"singleton" | "request">();
    defineDeps(RequestService, [[T.Logger]]);
    services.add(T.Logger, Singleton).as("singleton");
    services.add(T.Service, RequestService).as("request");

    const root = services.build().createScope("singleton");
    const reqA = root.createScope("request");
    const reqB = root.createScope("request");

    const a = reqA.resolve<RequestService>(T.Service);
    const b = reqB.resolve<RequestService>(T.Service);

    expect(a).not.toBe(b); // distinct request services
    expect(a.shared).toBe(b.shared); // ...sharing ONE singleton dep
  });

  test("a singleton's deps resolve from the singleton scope, not the trigger", () => {
    // Singleton A depends on singleton B. Both owned by the open singleton
    // frame. Resolving A from a deep child still constructs B relative to that
    // frame, and B is cached there.
    class B {
      public readonly id = "B";
    }
    class A {
      public constructor(public readonly b: B) {}
    }
    const services = new ServiceManifest<"singleton" | "request">();
    defineDeps(A, [[T.B]]);
    services.add(T.B, B).as("singleton");
    services.add(T.A, A).as("singleton");

    const root = services.build().createScope("singleton");
    const deepChild = root.createScope("request").createScope("request");

    const a = deepChild.resolve<A>(T.A);
    const bDirect = root.resolve<B>(T.B);

    // B was constructed during A's resolution and cached on the singleton frame
    // — resolving B directly from that frame returns the same cached instance.
    expect(a.b).toBe(bDirect);
  });
});
