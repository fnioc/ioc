import { closeToken, ServiceManifest, typeArg } from "@fnioc/di";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type CompiledProject, compileWithTransformer } from "./harness.js";

// Open-generics integration — the cross-package gate for the feature.
//
// A placeholder-authored fixture (`$<N>` holes + `Typeof<T>` witnesses) is
// compiled with the REAL ts-patch transformer; we assert the emitted ABI shape
// (template tokens + registration-carried signatures as `add()`'s third arg,
// no hoist/defineDeps for generic impls) and then LOAD the lowered output to
// run it against the live `@fnioc/di` engine: multiple closings as distinct
// per-closing singletons, correct closed deps, the Typeof witness, and
// exact-beats-open precedence.
//
// The fixture also carries a MANUAL (plugin-less) template registration on the
// same manifest, its token strings hand-written to the exact grammar the
// transformer derives — proving ABI unification in both directions: authored
// resolves hit the manual template, and manually-computed `closeToken(...)`
// strings hit the transformer-authored open registration.

const FILES: Record<string, string> = {
  "contracts.ts": `
export interface ILogger {
  log(line: string): void;
  readonly lines: readonly string[];
}
export interface IRepository<T> {
  save(entity: T): void;
  readonly entityToken: string;
  readonly kind: string;
}
export interface ICategoryLogger<T> {
  tag(msg: string): string;
  readonly category: string;
}
export interface IAudit<T> {
  record(entity: T): string;
}
export class User {}
export class Order {}
export class Invoice {}
`,
  "services.ts": `
import type { Typeof } from "@fnioc/core";
import type { IAudit, ICategoryLogger, ILogger, IRepository } from "./contracts.js";
import type { User } from "./contracts.js";

export class ConsoleLogger implements ILogger {
  readonly #buffer: string[] = [];
  public get lines(): readonly string[] {
    return this.#buffer;
  }
  public log(line: string): void {
    this.#buffer.push(line);
  }
}

/** The one erased class behind every SQL closing; the witness names the closing. */
export class SqlRepository<T> implements IRepository<T> {
  public readonly kind = "sql";
  public constructor(
    public readonly logger: ILogger,
    public readonly entityToken: Typeof<T>,
  ) {}
  public save(entity: T): void {
    this.logger.log("save:" + this.entityToken);
  }
}

/** A non-generic impl for ONE closing — the exact-beats-open override. */
export class SpecialUserRepository implements IRepository<User> {
  public readonly kind = "special";
  public readonly entityToken = "special:User";
  public constructor(public readonly logger: ILogger) {}
  public save(entity: User): void {
    this.logger.log("save:special");
  }
}

/** ILogger<T>-style witness demo: the category IS the type arg's token. */
export class CategoryLogger<T> implements ICategoryLogger<T> {
  public constructor(public readonly category: Typeof<T>) {}
  public tag(msg: string): string {
    return "[" + this.category + "] " + msg;
  }
}

/** Registered MANUALLY (plugin-less) — signatures hand-fed, tokens hand-written. */
export class AuditTrail<T> implements IAudit<T> {
  public constructor(
    public readonly repo: IRepository<T>,
    public readonly entityToken: string,
  ) {}
  public record(entity: T): string {
    this.repo.save(entity);
    return "audit:" + this.entityToken + ":via:" + this.repo.kind;
  }
}
`,
  "wiring.ts": `
import type { $ } from "@fnioc/core";
import { ServiceManifest, typeArg } from "@fnioc/di";
import type { ICategoryLogger, ILogger, IRepository } from "./contracts.js";
import type { User } from "./contracts.js";
import {
  AuditTrail,
  CategoryLogger,
  ConsoleLogger,
  SpecialUserRepository,
  SqlRepository,
} from "./services.js";

export type Scopes = "singleton" | "request";
export const services = new ServiceManifest<Scopes>();

services.add<ILogger>(ConsoleLogger).as<"singleton">();
// Open template — one erased class, per-closing cache identity.
services.add<IRepository<$<1>>>(SqlRepository<$<1>>).as<"singleton">();
// Exact closed registration beats the open fallback for this closing.
services.add<IRepository<User>>(SpecialUserRepository).as<"singleton">();
// Typeof witness, open across all closings.
services.add<ICategoryLogger<$<1>>>(CategoryLogger<$<1>>).as<"singleton">();

// MANUAL template registration on the SAME manifest (the transformer leaves
// explicit-token calls untouched): tokens hand-written to the derived grammar,
// so authored resolve<IAudit<Order>>() closes THIS registration, and its
// IRepository<$1> dep closes the transformer-authored open registration above.
services.add("./contracts/IAudit<$1>", AuditTrail, [["./contracts/IRepository<$1>", typeArg(1)]]).as("singleton");
`,
  "app.ts": `
import type { ServiceProvider } from "@fnioc/di";
import type { IAudit, ICategoryLogger, ILogger, IRepository } from "./contracts.js";
import { Invoice, Order, User } from "./contracts.js";
import { services, type Scopes } from "./wiring.js";

export function rootScope(): ServiceProvider<Scopes> {
  return services.build().createScope("singleton");
}

export interface Observations {
  readonly root: ServiceProvider<Scopes>;
  readonly orderA: IRepository<Order>;
  readonly orderB: IRepository<Order>;
  readonly invoice: IRepository<Invoice>;
  readonly user: IRepository<User>;
  readonly orderCat: ICategoryLogger<Order>;
  readonly invoiceCat: ICategoryLogger<Invoice>;
  readonly orderAudit: IAudit<Order>;
  readonly auditLine: string;
  readonly logger: ILogger;
}

/** Resolves every closing tokenlessly — the authored resolve<T>() form. */
export function observe(): Observations {
  const root = rootScope();
  const orderA = root.resolve<IRepository<Order>>();
  const orderB = root.resolve<IRepository<Order>>();
  const invoice = root.resolve<IRepository<Invoice>>();
  const user = root.resolve<IRepository<User>>();
  const orderCat = root.resolve<ICategoryLogger<Order>>();
  const invoiceCat = root.resolve<ICategoryLogger<Invoice>>();
  const orderAudit = root.resolve<IAudit<Order>>();
  const auditLine = orderAudit.record(new Order());
  const logger = root.resolve<ILogger>();
  return { root, orderA, orderB, invoice, user, orderCat, invoiceCat, orderAudit, auditLine, logger };
}
`,
};

// The token strings the transformer derives for the fixture (pinned by the
// emit-shape assertions below; the behavioral tests reuse them for the
// manual-token cross-checks).
const T = {
  logger: "./contracts/ILogger",
  repoBase: "./contracts/IRepository",
  repoTemplate: "./contracts/IRepository<$1>",
  catTemplate: "./contracts/ICategoryLogger<$1>",
  user: "./contracts/User",
  order: "./contracts/Order",
  invoice: "./contracts/Invoice",
} as const;

interface LoadedRepo {
  readonly kind: string;
  readonly entityToken: string;
}
interface LoadedObservations {
  readonly root: { resolve: (token: string) => unknown };
  readonly orderA: LoadedRepo;
  readonly orderB: LoadedRepo;
  readonly invoice: LoadedRepo;
  readonly user: LoadedRepo;
  readonly orderCat: { tag: (msg: string) => string; category: string };
  readonly invoiceCat: { category: string };
  readonly auditLine: string;
  readonly logger: { readonly lines: readonly string[] };
}

let project: CompiledProject;

beforeAll(() => {
  project = compileWithTransformer(FILES);
}, 60_000);

afterAll(() => project?.cleanup());

// ── Emitted ABI shape ─────────────────────────────────────────────────────────

describe("emit contract — open-generics lowered ABI", () => {
  test("open registration: template token + carried signatures, no hoist, no defineDeps", () => {
    const wiring = project.emitted("wiring.js");
    expect(wiring).toContain(
      `services.add("${T.repoTemplate}", SqlRepository, `
        + `[["${T.logger}", { typeArg: 1 }]]).as("singleton");`,
    );
    // Generic impls carry their signatures ON the registration: no `const
    // ɵregN = SqlRepository` hoist and no ctor-keyed defineDeps for them.
    expect(wiring).not.toMatch(/const ɵreg\d+ = SqlRepository;/);
    expect(wiring).not.toMatch(/const ɵreg\d+ = CategoryLogger;/);
  });

  test("Typeof-only ctor lowers to a single open { typeArg: 1 } slot", () => {
    const wiring = project.emitted("wiring.js");
    expect(wiring).toContain(
      `services.add("${T.catTemplate}", CategoryLogger, [[{ typeArg: 1 }]]).as("singleton");`,
    );
  });

  test("exact closed registration: closed token, non-generic impl carries its inline signature", () => {
    const wiring = project.emitted("wiring.js");
    expect(wiring).not.toMatch(/const ɵreg\d+ = SpecialUserRepository;/);
    expect(wiring).not.toContain("defineDeps");
    expect(wiring).toContain(
      `services.add("${T.repoBase}<${T.user}>", SpecialUserRepository, `
        + `[["${T.logger}"]]).as("singleton");`,
    );
  });

  test("manual (explicit-token) registration passes through the transformer untouched", () => {
    const wiring = project.emitted("wiring.js");
    expect(wiring).toContain("services.add(\"./contracts/IAudit<$1>\", AuditTrail, ");
    expect(wiring).toContain(`"${T.repoTemplate}", typeArg(1)`);
  });

  test("authored tokenless resolve<T>() picks up closed tokens", () => {
    const app = project.emitted("app.js");
    expect(app).toContain(`root.resolve("${T.repoBase}<${T.order}>")`);
    expect(app).toContain(`root.resolve("${T.repoBase}<${T.user}>")`);
  });
});

// ── Lowered output running against the live engine ───────────────────────────

describe("behavior — multiple closings against the real di engine", () => {
  test("each closing is a distinct per-closing singleton with correct closed deps", async () => {
    const app = await project.load("app.js");
    const obs = (app.observe as () => LoadedObservations)();

    // Same closing → same instance (singleton caches per CLOSED token).
    expect(obs.orderA).toBe(obs.orderB);
    // Different closings → distinct instances of the same erased class.
    expect(obs.invoice).not.toBe(obs.orderA);
    expect(obs.orderA.kind).toBe("sql");
    expect(obs.invoice.kind).toBe("sql");
    // The Typeof witness carries each closing's arg token.
    expect(obs.orderA.entityToken).toBe(T.order);
    expect(obs.invoice.entityToken).toBe(T.invoice);
    // The shared ILogger dep resolved: the audit's save call logged through it.
    expect(obs.logger.lines).toContain(`save:${T.order}`);
  });

  test("exact registration beats the open fallback", async () => {
    const app = await project.load("app.js");
    const obs = (app.observe as () => LoadedObservations)();
    expect(obs.user.kind).toBe("special");
    expect(obs.user.entityToken).toBe("special:User");
    // Sibling closings still fall back to the open registration.
    expect(obs.orderA.kind).toBe("sql");
  });

  test("ILogger<T>-style witness: category = the closing's arg token", async () => {
    const app = await project.load("app.js");
    const obs = (app.observe as () => LoadedObservations)();
    expect(obs.orderCat.category).toBe(T.order);
    expect(obs.invoiceCat.category).toBe(T.invoice);
    expect(obs.orderCat.tag("hi")).toBe(`[${T.order}] hi`);
  });
});

// ── ABI unification — manual and transformer-derived tokens are one grammar ──

describe("ABI unification — manual path ↔ transformer-derived tokens", () => {
  test("authored resolve closes the MANUAL template; its dep closes the authored open reg", async () => {
    const app = await project.load("app.js");
    const obs = (app.observe as () => LoadedObservations)();
    // AuditTrail was registered plugin-lessly (hand-written template token +
    // typeArg(1) signature); resolve<IAudit<Order>>() reached it, and its
    // `IRepository<$1>` dep closed against the transformer-authored open
    // registration — recursive unification across both production paths.
    expect(obs.auditLine).toBe(`audit:${T.order}:via:sql`);
  });

  test("manually-computed closeToken hits the transformer-authored open registration", async () => {
    const app = await project.load("app.js");
    const obs = (app.observe as () => LoadedObservations)();
    // closeToken renders the same canonical string the transformer derives, so
    // a plugin-less consumer addresses the compiled graph directly.
    const viaManualToken = obs.root.resolve(closeToken(T.repoBase, T.order));
    expect(viaManualToken).toBe(obs.orderA);
  });

  test("plugin-less manifest: carried signatures via add(token, ctor, signatures)", () => {
    class Logger {
      public readonly id = "logger";
    }
    class Repo {
      public constructor(
        public readonly logger: Logger,
        public readonly entityToken: string,
      ) {}
    }
    const services = new ServiceManifest<"singleton">();
    services.add("app:ILogger", Logger).as("singleton");
    services.add("app:IRepo<$1>", Repo, [["app:ILogger", typeArg(1)]]).as("singleton");
    const root = services.build().createScope("singleton");

    const cats = root.resolve<Repo>(closeToken("app:IRepo", "app:Cat"));
    const dogs = root.resolve<Repo>(closeToken("app:IRepo", "app:Dog"));
    expect(cats).not.toBe(dogs);
    expect(cats.logger).toBe(dogs.logger);
    expect(cats.entityToken).toBe("app:Cat");
    expect(dogs.entityToken).toBe("app:Dog");
    expect(root.resolve<Repo>(closeToken("app:IRepo", "app:Cat"))).toBe(cats);
  });

  test("plugin-less manifest: single-hole template signature carried inline", () => {
    class Logger {
      public readonly id = "logger";
    }
    class Box {
      public constructor(public readonly content: unknown) {}
    }
    class Thing {
      public readonly name = "thing";
    }
    const services = new ServiceManifest<"singleton">();
    services.add("app:Logger", Logger).as("singleton");
    services.add("integ:Thing", Thing).as("singleton");
    // The hole-template signature rides on the registration (the global store is
    // retired) — `$1` substitutes to the closing's arg token per resolution.
    services.add("app:IBox<$1>", Box, [["$1"]]).as("singleton");
    const root = services.build().createScope("singleton");

    const box = root.resolve<Box>(closeToken("app:IBox", "integ:Thing"));
    expect((box.content as Thing).name).toBe("thing");
    expect(root.resolve<Box>(closeToken("app:IBox", "integ:Thing"))).toBe(box);
  });
});
