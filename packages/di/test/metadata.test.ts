import { test, expect, describe } from "bun:test";
import {
  ServiceManifest,
  MissingMetadataError,
  CircularDependencyError,
} from "@fnioc/di";
import { defineDeps } from "@fnioc/core";
import { T } from "./fixtures.js";

// Metadata handling: zero-arg ctor constructs directly; a ctor with params but
// no DepRecord throws with guidance. Plus cycle detection with the full path.

describe("missing metadata", () => {
  test("a zero-arg ctor is constructed directly (no dep lookup)", () => {
    class NoDeps {
      public readonly ok = true;
    }
    const services = new ServiceManifest<"singleton">();
    services.add(T.Service, NoDeps).as("singleton");

    const instance = services.build().resolve<NoDeps>(
      T.Service,
    );
    expect(instance.ok).toBe(true);
  });

  test("a ctor with params but no metadata throws MissingMetadataError", () => {
    class NeedsParams {
      public constructor(public readonly a: unknown) {}
    }
    // No defineDeps call — the transformer never saw it and it's un-annotated.
    const services = new ServiceManifest<"singleton">();
    services.add(T.Service, NeedsParams).as("singleton");

    const root = services.build();
    expect(() => root.resolve(T.Service)).toThrow(MissingMetadataError);
  });

  test("the MissingMetadataError names the ctor and the token", () => {
    class WidgetService {
      public constructor(public readonly a: unknown) {}
    }
    const services = new ServiceManifest<"singleton">();
    services.add(T.Service, WidgetService).as("singleton");

    try {
      services.build().resolve(T.Service);
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingMetadataError);
      const e = err as MissingMetadataError;
      expect(e.ctorName).toBe("WidgetService");
      expect(e.token).toBe(T.Service);
      expect(e.message).toContain("forCtor");
      expect(e.message).toContain("useFactory");
    }
  });

  test("an empty-signatures DepRecord on a param ctor still throws", () => {
    class EdgeCase {
      public constructor(public readonly a: unknown) {}
    }
    defineDeps(EdgeCase, []); // record exists but no signatures
    const services = new ServiceManifest<"singleton">();
    services.add(T.Service, EdgeCase).as("singleton");

    expect(() =>
      services.build().resolve(T.Service),
    ).toThrow(MissingMetadataError);
  });
});

describe("cycle detection", () => {
  test("a direct A→B→A cycle throws with the full path", () => {
    class A {
      public constructor(public readonly b: unknown) {}
    }
    class B {
      public constructor(public readonly a: unknown) {}
    }
    defineDeps(A, [[T.B]]);
    defineDeps(B, [[T.A]]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.A, A).as("singleton");
    services.add(T.B, B).as("singleton");

    const root = services.build();
    expect(() => root.resolve(T.A)).toThrow(CircularDependencyError);

    try {
      root.resolve(T.A);
    } catch (err) {
      const e = err as CircularDependencyError;
      // Path closes the loop: A → B → A.
      expect(e.path).toEqual([T.A, T.B, T.A]);
      expect(e.message).toContain(`${T.A} → ${T.B} → ${T.A}`);
    }
  });

  test("a self-cycle (A→A) throws", () => {
    class SelfRef {
      public constructor(public readonly self: unknown) {}
    }
    defineDeps(SelfRef, [[T.A]]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.A, SelfRef).as("singleton");

    const root = services.build();
    expect(() => root.resolve(T.A)).toThrow(CircularDependencyError);
  });

  test("a longer A→B→C→A cycle reports the full path", () => {
    class A {
      public constructor(public readonly b: unknown) {}
    }
    class B {
      public constructor(public readonly c: unknown) {}
    }
    class C {
      public constructor(public readonly a: unknown) {}
    }
    defineDeps(A, [[T.B]]);
    defineDeps(B, [[T.C]]);
    defineDeps(C, [[T.A]]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.A, A).as("singleton");
    services.add(T.B, B).as("singleton");
    services.add(T.C, C).as("singleton");

    try {
      services.build().resolve(T.A);
      throw new Error("expected a throw");
    } catch (err) {
      const e = err as CircularDependencyError;
      expect(e.path).toEqual([T.A, T.B, T.C, T.A]);
    }
  });

  test("a diamond (shared, non-cyclic dep) does NOT falsely trip", () => {
    // A depends on B and C; both B and C depend on D. D appears twice but on
    // separate branches — not a cycle. The stack is popped between branches.
    class D {
      public readonly id = "D";
    }
    class B {
      public constructor(public readonly d: D) {}
    }
    class C {
      public constructor(public readonly d: D) {}
    }
    class A {
      public constructor(
        public readonly b: B,
        public readonly c: C,
      ) {}
    }
    defineDeps(D, [[]]);
    defineDeps(B, [[T.Db]]);
    defineDeps(C, [[T.Db]]);
    defineDeps(A, [[T.B, T.C]]);

    const services = new ServiceManifest<"singleton">();
    services.add(T.Db, D).as("singleton");
    services.add(T.B, B).as("singleton");
    services.add(T.C, C).as("singleton");
    services.add(T.A, A).as("singleton");

    const a = services.build().createScope("singleton").resolve<A>(T.A);
    expect(a.b.d).toBe(a.c.d); // shared singleton D, no false cycle
  });
});
