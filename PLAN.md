# ioc — Implementation Plan & Progress Tracker

**What this document is:** The authoritative execution roadmap and living progress tracker for the `ioc` monorepo (`fnioc/ioc`, npm scope `@fnioc`). It encodes the full dependency DAG, phase-by-phase checklists, subagent decomposition, and parallelism constraints. Design ground truth lives in `PRD.md` — this document is about *execution and tracking*, not design prose.

**How to use it:** As each task lands, tick the checkbox and update the dashboard row's Status and Notes columns. Append to the Progress Log on any significant state change. If a track gets stuck, append to `blockers.md` (see §Risks).

---

## Status Legend

| Symbol | Meaning |
|--------|---------|
| ⬜ | Not started |
| 🟡 | In progress |
| ✅ | Done |
| 🔴 | Blocked |

---

## Status Dashboard

| Phase / Track | Status | Notes |
|---|---|---|
| **Phase 0** — Scaffold (main checkout) | 🟡 | Scaffold pushed to `fnioc/ioc`; verifying first green CI run
| **Phase 1** — `@fnioc/core` (ABI + WeakMap + authoring surfaces) | ⬜ | BARRIER: di + transformer both block on this |
| **Phase 2A** — `@fnioc/di` runtime | ⬜ | Parallel with 2B + 2C after Phase 1 |
| **Phase 2B** — `@fnioc/transformer` | ⬜ | Parallel with 2A + 2C after Phase 1 |
| **Phase 2C** — Docs (README + API reference) | ⬜ | Parallel with 2A + 2B once API shape is firm (it is) |
| **Phase 3** — Integration & verification | ⬜ | BARRIER: needs 2A + 2B green |
| **Phase 4** — Packaging & publish | ⬜ | Sequential after Phase 3 |
| **Phase 5** — Dir rename + session transfer | ⬜ | Deferred to end; keep cwd stable throughout |
| **Standing** — `rhombus-toolkit/ts` issue filing | ⬜ | Ongoing; high bar for filing |

---

## Dependency DAG

```
Phase 0  Scaffold (MAIN CHECKOUT — no worktree; repo doesn't exist yet)
   │       git init · toolchain mirror · pkg skeletons · tsconfigs · CI workflows
   │       THE BUILD DEVIATION (tsc → dist + .d.ts) · first commit · gh repo create
   │       fnioc/ioc (SSH) · push · arm CI monitor
   │
Phase 1  @fnioc/core
   │       ABI + global-symbol WeakMap + defineDeps + @signature + forCtor
   │       Token + hole + ABI_VERSION
   │       [CRITICAL PATH BARRIER — di AND transformer both block here]
   │
   ├────────────────────┬─────────────────────┬──────────────────────┐
Phase 2A              Phase 2B              Phase 2C            ALL THREE CONCURRENT
@fnioc/di runtime     @fnioc/transformer    Docs: README +      worktree-per-subagent
(hand-fed, no         (ts-patch)            API reference       NO isolation:"worktree"
 plugin needed)                             (sonnet-shaped)
   │                    │                     │
   └────────────────────┴─────────────────────┘
Phase 3  Integration & verification
   │       [BARRIER: needs di + transformer green]
   │       · compile sample WITH transformer, run against di (ABI contract)
   │       · progressive-enhancement e2e (with + without plugin)
   │       · captive-dep · cycle · disposal sync+async · async-as-values · overloads
   │
Phase 4  Packaging & publish
   │       [sequential after Phase 3]
   │       · real build output verification · ts-patch/TS compat · @fnioc scope claim
   │       · OIDC trusted-publisher config · first release-please release
   │       · MONITOR full chain to installable
   │
Phase 5  Dir rename (ioc@rhombus-toolkit → ioc@fnioc) + session transfer
```

**Barriers:** Phase 1 is the hard synchronization point — nothing in 2A or 2B can start until `core` is merged and green on `main`. Phase 3 is the second barrier — it blocks on both `di` and `transformer` being independently green. Phase 4 is sequential after 3.

**Concurrent fan-out:** Phases 2A, 2B, and 2C run fully in parallel after Phase 1. `di` and `transformer` share only the ABI and token format from `core`; they are otherwise independent. `di` is developed and tested hand-fed (hand-written tokens + `defineDeps` calls, no transformer involved) — this is the design property that makes the parallelism valid and matches the locked design's build-order intent.

---

## Phase 0 — Scaffold (main checkout)

**Dependencies:** none — repo does not exist yet; work happens in the main checkout.

**Acceptance criteria:** CI runs and goes green on first push; all three package skeletons build (`tsc` → `dist/`); Moon task graph resolves; release-please config parses.

### Checklist

- [ ] `git init` in `~/src/ioc@rhombus-toolkit` (rename to `ioc@fnioc` deferred to Phase 5)
- [ ] `mise.toml` — pin Bun + Moon (mirror `fnclaude@fnclaude` versions)
- [ ] `bunfig.toml`
- [ ] `.moon/workspace.yml` — define `packages/*` glob
- [ ] `.moon/toolchain.yml` — Bun runtime
- [ ] Root `package.json` (workspace root, private)
- [ ] Three package skeletons: `packages/core/`, `packages/di/`, `packages/transformer/`
  - [ ] `packages/core/package.json` — name `@fnioc/core`, `main`/`types`/`exports` → `dist/`
  - [ ] `packages/di/package.json` — name `@fnioc/di`, dep on `@fnioc/core`
  - [ ] `packages/transformer/package.json` — name `@fnioc/transformer`, dep on `@fnioc/core`
- [ ] `tsconfig.base.json` — `lib: ["ES2022", "ESNext.Disposable"]`, target ES2022, NodeNext module/moduleResolution, strict, `noUncheckedIndexedAccess`, `isolatedModules`, `declaration`, `declarationMap`, `sourceMap`
- [ ] Per-package `tsconfig.json` extending base; `outDir: "dist"`, `rootDir: "src"`
- [ ] Per-package `moon.yml` — `build` task: `bun tsc -p tsconfig.json`, `outputs: ['dist']`; `test` task; `lint` task
- [ ] **THE BUILD DEVIATION:** confirm Moon `build` task uses `tsc` (not `bun run` passthrough) — `ioc` is a library shipping to node/webpack/vite/tsc consumers, not a Bun app. `main`/`types`/`exports` point at `dist/`, not `src/`.
- [ ] `.github/workflows/ci.yml` — `verify` job (checkout w/ 3× retry + `fetch-depth: 0`, `mise-action`, `bun install --frozen-lockfile`, `moon run :lint/:test/:build`) + `publish` job (release-please-action + AUTOMERGE_PAT, OIDC trusted-publishing, `workspace:*`→concrete-version rewrite, topo-sort dependents-last, verify-deps-resolve guard, `npm publish --provenance`). Workflow file MUST be named `ci.yml` (OIDC trusted-publisher config references it by name).
- [ ] `.github/workflows/auto-merge.yml` — squash auto-merge via AUTOMERGE_PAT
- [ ] `.github/FUNDING.yml` — `github: fnrhombus`, `buy_me_a_coffee: fnrhombus`
- [ ] `.release-please-manifest.json` + `release-please-config.json` — `separate-pull-requests: true`, `include-component-in-tag: true`, one entry per package
- [ ] `.gitignore` — `dist/`, `node_modules/`, `*.tsbuildinfo`
- [ ] Pre-commit hooks via mise hooksPath (mirror fnclaude pattern)
- [ ] `bun install` — verify lockfile generates cleanly
- [ ] `moon run :build` — verify all three packages produce `dist/` (empty/stub passes)
- [ ] First commit
- [ ] `gh repo create fnioc/ioc --public` (SSH remote)
- [ ] Push `main`
- [ ] Arm CI Monitor (see §Standing Tasks — CI monitoring discipline)

---

## Phase 1 — `@fnioc/core`

**Dependencies:** Phase 0 green.

**Acceptance criteria:** All items below pass `bun test`. `core` builds to `dist/`. The ABI shape (`DepRecord`), `ABI_VERSION`, global-symbol WeakMap, `defineDeps`, `@signature`, `forCtor`, `Token`, and `hole` are all exported and typed correctly. Two copies of `core` at the same `ABI_VERSION` share one WeakMap via `Symbol.for`.

**Branch:** `feat-core` in a worktree.

### Checklist

- [ ] `Token` type alias (`= string`, no branding, no literal types)
- [ ] `hole` sentinel — exported `null` alias; wire value is `null` (JSON-friendly)
- [ ] `ABI_VERSION` — exported integer constant (`1`)
- [ ] `DepRecord` shape — `{ abi: number, signatures: ReadonlyArray<ReadonlyArray<Token | null>> }`
- [ ] Global-symbol WeakMap — `globalThis[Symbol.for(\`@fnioc/core:deps@${ABI_VERSION}\`)] ??= new WeakMap()` at module init; all reads/writes through this key. `Symbol.for` only (never unique symbol); version-suffixed.
- [ ] `defineDeps(ctor, signatures)` — merges (appends unique) signatures into the ctor's `DepRecord`; creates the record if absent; writes through the global-symbol WeakMap
- [ ] `@signature(...tokens)` — TC39 class decorator (NOT legacy); on apply calls `defineDeps(ctor, [[...tokens]])`; stacking = overloads
- [ ] `forCtor(ctor).signature(...tokens)` — fluent free-function; chaining = overloads; same `signature` verb as the ABI field and the decorator
- [ ] Unit tests: `defineDeps` append-unique semantics; WeakMap key isolation by ABI version; two-copies-share-one-map scenario; `@signature` stacking; `forCtor` chaining; `hole` wire value
- [ ] `packages/core/src/index.ts` exports all of the above
- [ ] `moon run core:build` green (`dist/` generated with `.d.ts`)
- [ ] `moon run core:test` green
- [ ] PR opened → CI green → merge to `main`

---

## Phase 2A — `@fnioc/di` Runtime

**Dependencies:** Phase 1 merged to `main`.

**Acceptance criteria:** Full di test suite green with hand-fed tokens (no transformer). Progressive-enhancement property holds: hand-fed tokens work identically to transformer-lowered tokens. All correctness rules from the locked design pass.

**Subagent decomposition:** One subagent per internal stage (stages are sequential within 2A, but 2A itself runs concurrently with 2B and 2C). Create worktrees with `git worktree add` before dispatching; agent `cd`s into the worktree as its first action. No `isolation:"worktree"` flag.

**Wall-clock note:** Stages 2A.3–2A.6 are largely parallel after 2A.2 lands — evaluate at dispatch time whether each is large enough to warrant a separate subagent or whether one agent serializing them is faster (see §Parallelism Notes).

### Internal stage sequence

#### 2A.1 — Engine core, hand-fed

**Branch:** `feat-di-core`

- [ ] `DiBuilder<Scopes extends string>` class skeleton
- [ ] `RegistrationMap` internal structure — keyed by token string
- [ ] `services.add<IFoo>(MyConcrete)` — one type param; concrete typed `new (...args: any[]) => IFoo`; plain `new`, NOT `abstract new`
- [ ] `.as<S extends Scopes>()` fluent — attaches lifetime tag; compile-time `S extends Scopes` check
- [ ] WeakMap read via `@fnioc/core`'s global-symbol key to retrieve `DepRecord`
- [ ] Positional resolution: for each signature token, resolve registered dep or treat as `hole`; `new Ctor(...resolvedArgs)`
- [ ] Hand-fed token tests: register `"my:IFoo"` → `MyFoo`; resolve; assert correct instance
- [ ] `moon run di:test` green

#### 2A.2 — Scope chain + tagged lifetimes

**Branch:** `feat-di-scopes`

- [ ] `services.createScope(tag)` → returns a child `Scope` with parent reference
- [ ] Registration lookup: child scope shadows parent (Angular-style hierarchical walk up)
- [ ] Instance ownership: lifetime tag walks UP the parent chain to find the nearest ancestor scope with a matching tag; cache instance there
- [ ] **Throw if no ancestor scope matches the tag** — this is the captive-dependency protection; never auto-create a scope
- [ ] Transient (no tag): fresh instance every resolve, never cached
- [ ] Root/singleton scope must be an explicit app-lifetime object; no lazy mint per-resolve
- [ ] Tests: singleton cached; request scoped per-request scope; transient fresh; throw on mismatched tag

#### 2A.3 — Correctness: captive-dep, cycles, disposal

**Branch:** `feat-di-correctness`

- [ ] **Captive-dep rule (§5.4):** resolve constructor deps relative to the scope that will OWN the instance (not the scope that triggered the resolve); singleton depending on request-scoped dep throws
- [ ] **Cycle detection:** maintain resolution stack; token reappearance → throw with full resolution path in message
- [ ] **Disposal — sync:** `scope.dispose()` disposes owned instances in reverse construction order; only instances implementing `Disposable` / `Symbol.dispose`; `sync dispose()` THROWS if scope owns a `Promise`-valued disposable (directs to `disposeAsync()`)
- [ ] **Disposal — async:** `scope.disposeAsync()` handles `AsyncDisposable` / `Symbol.asyncDispose`; uses `await using` semantics (TS 5.2+); reverse construction order
- [ ] **Native disposal only:** `Disposable`/`AsyncDisposable` from TS lib — NOT a `@rhombus-toolkit` Disposable
- [ ] Tests: captive-dep throw; cycle throw with path; sync dispose order; async dispose order; sync-dispose-on-async-disposable throws

#### 2A.4 — Greedy overload selection

**Branch:** `feat-di-overloads`

- [ ] When a ctor has multiple registered signatures (`DepRecord.signatures.length > 1`): scan longest → shortest; pick first where every param is satisfiable (token registered ∨ `hole` ∨ factory-typed)
- [ ] Equal-arity ties → registration order
- [ ] Tests: longest wins; shorter fallback when longest unsatisfiable; equal-arity registration-order tie

#### 2A.5 — Factories

**Branch:** `feat-di-factories`

- [ ] Bare factory injection: param annotation is a literal arrow/function type returning a registered type → inject as factory, not instance
- [ ] Named function-interface (e.g. `interface IFooThunk { (): IFoo }`) → resolves as a normal service by its own token (the explicit opt-out)
- [ ] Partial/positional factories: factory params are the **unregistered** ctor params in relative order; holes filled positionally by caller args at call time
- [ ] Runtime partition against live registration map (no whole-program analysis); positional collapse of unregistered params
- [ ] Tests: bare factory injection; partial factory param ordering; named-interface opt-out; `(a: A, b: B) => IFoo` where A is registered, B is not

#### 2A.6 — Override paths

**Branch:** `feat-di-overrides`

- [ ] `container.register(token, { useFactory: (c) => ... })` — no dep array, no decorator, closure wires deps
- [ ] `container.register(token, { useValue: instance })` — static instance
- [ ] Re-export `@signature`, `forCtor`, `hole` from `@fnioc/core` (one-import ergonomics for consumers)
- [ ] Tests: `useFactory` wires correctly; `useValue` returns same instance; override shadows parent registration
- [ ] `moon run di:build` green (full package)
- [ ] `moon run di:test` green (full suite)
- [ ] PR opened → CI green → merge to `main`

---

## Phase 2B — `@fnioc/transformer`

**Dependencies:** Phase 1 merged to `main`. Runs concurrently with 2A and 2C.

**Acceptance criteria:** `ts-patch` harness compiles; token generation is stable across the publish boundary; `defineDeps` emission matches the ABI; registration lowering round-trips correctly; all §4.5 diagnostics fire on fixture inputs. TDD throughout with fixture compilations.

**Subagent decomposition:** One subagent handling the sequential internal stages (2B.1–2B.4 are themselves sequential; the whole track is independent of 2A).

**Branch:** `feat-transformer` in a worktree.

### Internal stage sequence

#### 2B.1 — ts-patch harness

- [ ] `ts-patch` dev dependency in `packages/transformer/package.json`; `patchTs` step in Moon `build` task
- [ ] Transformer entry point skeleton — `TransformerFactory` signature compatible with ts-patch
- [ ] Fixture compilation test harness: input `.ts` source → run transformer → compare output `.ts` snapshot
- [ ] Smoke test: identity transform compiles cleanly

#### 2B.2 — Token generation

- [ ] Walk up to nearest `package.json` to determine owning package + whether a symbol is publicly exported
- [ ] Public export token: `packageName + publicExportSubpath + symbolName` (e.g. `your-lib:contracts/IFoo`) — stable across publish boundary; version EXCLUDED from token
- [ ] App-internal (non-exported) type token: source-relative path token
- [ ] Document multiple-install / version-skew caveat in generated output comments or README
- [ ] Tests: public-export token stability; internal-type token; cross-package token matches what a consumer would import

#### 2B.3 — Dep extraction + `defineDeps` emission + registration lowering

- [ ] At each `services.add<IFoo>(MyConcrete)` site: read ctor param types via TypeChecker; compute token per param; emit `null` only for types that can never be tokens (primitives)
- [ ] Emit `defineDeps(MyConcrete, [[...tokens]])` call before the registration site
- [ ] Emit `services.add("pkg:IFoo", MyConcrete).as("tag")` (lowered form)
- [ ] `Promise<X>` unwrap: param typed `Promise<X>` → same token as `X`
- [ ] Lowered output format is the ABI contract — must match `DepRecord.signatures` shape exactly
- [ ] Tests: dep extraction round-trips; `null` for primitives; `Promise<X>` unwrap; multi-param class; registration lowering output snapshot

#### 2B.4 — Diagnostics + edge cases

- [ ] **§4.5 diagnostic:** validate factory signatures against the target ctor's unregistered params in order; warn on equal-arity overload ambiguity; warn where consumer declared `IDb` but service is async-registered (should be `Promise<IDb>`)
- [ ] **Already-annotated class:** manual annotation (`@signature`/`forCtor`) is authoritative → transformer SKIPS emission + emits an info diagnostic (never silent, never double-writes)
- [ ] **Fully-dynamic class** (ctor transformer cannot statically see): no dep array emitted; runtime will throw with guidance if ctor has params but no metadata
- [ ] Tests: factory-sig diagnostic fires; already-annotated skip + info diagnostic; dynamic-class produces no emission; equal-arity ambiguity warning
- [ ] `moon run transformer:build` green
- [ ] `moon run transformer:test` green
- [ ] PR opened → CI green → merge to `main`

---

## Phase 2C — Docs

**Dependencies:** Phase 1 merged (API shape is firm). Runs concurrently with 2A and 2B.

**Subagent:** Dispatch a Sonnet subagent (prose-shaped work) into the `feat-docs` worktree.

**Branch:** `feat-docs` in a worktree.

### Checklist

- [ ] `packages/core/README.md` — API reference: `Token`, `hole`, `ABI_VERSION`, `DepRecord`, `defineDeps`, `@signature`, `forCtor`
- [ ] `packages/di/README.md` — advertisement-oriented: the "lowering" analogy, progressive-enhancement model (with + without transformer), `DiBuilder`, scope model, `createScope`, `.add().as()`, `useFactory`/`useValue`, disposal, factories, greedy overload selection
- [ ] `packages/transformer/README.md` — ts-patch setup, token derivation rule + version-skew caveat, `Promise<X>` unwrap, `@signature`/`forCtor` opt-out, §4.5 diagnostic description
- [ ] Root `README.md` — monorepo overview, links to package READMEs, the three-package dependency diagram, quick-start (install + transformer config + first registration)
- [ ] PR opened → merged (no CI gate on docs; merge at will)

---

## Phase 3 — Integration & Verification

**Dependencies:** Phase 2A (di) AND Phase 2B (transformer) both merged to `main`.

**Acceptance criteria:** All integration tests pass. The progressive-enhancement property holds end-to-end. ABI contract test passes (transformer output → di resolves correctly). No regressions on hand-fed token paths.

**Branch:** `feat-integration` in a worktree.

### Checklist

- [ ] Sample app under `examples/` or `test/integration/`: classes authored type-driven against the sample scope union
- [ ] Compile sample WITH transformer (`ts-patch`): verify lowered output matches expected ABI shape
- [ ] Run lowered sample against `@fnioc/di`: resolve the full dependency graph; assert correct instances
- [ ] **ABI contract test:** transformer-emitted `defineDeps` calls produce a `DepRecord` that `di` reads identically to a hand-fed one
- [ ] **Progressive-enhancement e2e:** same sample compiles and runs WITHOUT transformer (hand-fed tokens + `@signature`/`forCtor`); assert behavioral parity
- [ ] Captive-dep test: singleton depending on request-scoped service → throws with informative message
- [ ] Cycle detection test: `A → B → A` → throws with full resolution path
- [ ] Disposal sync test: close scope → `dispose()` called in reverse construction order
- [ ] Disposal async test: `disposeAsync()` on `AsyncDisposable` instances; correct order
- [ ] Async-as-values test: `useFactory` returning `Promise<T>`; consumer declares dep as `Promise<T>`; singleton caches the Promise; multiple awaits resolve to same instance
- [ ] Greedy overload selection test: transformer-emitted multi-signature class; di selects longest satisfiable signature
- [ ] `moon run :test` across all packages green
- [ ] PR opened → CI green → merge to `main`

---

## Phase 4 — Packaging & Publish

**Dependencies:** Phase 3 merged to `main`.

**Acceptance criteria:** `@fnioc/core`, `@fnioc/di`, `@fnioc/transformer` published to npm under the `@fnioc` scope with provenance; OIDC trusted-publishing flow works end-to-end; release-please generates correct version PRs.

### Checklist

- [ ] **Real build output verification:** `moon run :build` produces `dist/` with correct `.js` + `.d.ts` + `.d.ts.map` + `.js.map`; `package.json` `main`/`types`/`exports` resolve correctly under `node`
- [ ] **ts-patch ↔ TS version compat check:** verify the installed `ts-patch` version supports the TypeScript version pinned in `mise.toml`; document the tested pair (see §Standing Tasks)
- [ ] **`@fnioc` scope claim:** retrieve the `rhombulus` god token from Bitwarden; run equivalent of `claim-npm.ps1` to register the `@fnioc` org on npmjs.com
- [ ] **OIDC trusted-publisher config on npmjs.com:** provider=GitHub Actions, repo=`fnioc/ioc`, workflow=`ci.yml` (exact filename — do not rename the workflow)
- [ ] **`AUTOMERGE_PAT` secret:** confirm set on `fnioc/ioc` repo (needed for release-please auto-merge)
- [ ] **First release:** merge a release-please PR (or trigger manually); verify it produces correct version tags with `include-component-in-tag` format
- [ ] **Monitor the full publish chain:** PR test → auto-merge → release-please PR → release-please merge → `release.yml` → npm publish with provenance → installable. Arm Monitor before the first publish attempt; PushNotification on terminal states. See §Standing Tasks — CI monitoring discipline.
- [ ] **Verify install from npm:** `bun add @fnioc/core @fnioc/di` in a scratch project; import and run the basic usage path
- [ ] All three packages installable and functional

---

## Phase 5 — Dir Rename + Session Transfer

**Dependencies:** Phase 4 complete. Deferred to the END to keep one stable `cwd` throughout the full build.

**Approach:** `mv ~/src/ioc@rhombus-toolkit ~/src/ioc@fnioc`, then `fnc_switch_project` / `fnc_spawn_session` to re-anchor Claude Code at the new path. If a copy+transfer approach is used instead, DELETE the old folder afterward — no lingering duplicates.

### Checklist

- [ ] Confirm Phase 4 complete and all work pushed
- [ ] `mv ~/src/ioc@rhombus-toolkit ~/src/ioc@fnioc`
- [ ] Re-anchor Claude Code session at `~/src/ioc@fnioc`
- [ ] Verify git remote, Moon, and Bun all resolve correctly from the new path
- [ ] Delete old path if it still exists (copy+transfer path only)

---

## Parallelism Notes

**What runs concurrently:**
- Phases 2A, 2B, 2C start in the same dispatch turn after Phase 1 is merged. Three subagents, three worktrees, three independent branch names.
- Within 2A: stages 2A.3–2A.6 can overlap after 2A.2 lands — evaluate at dispatch time. If each stage is ≥20 minutes of real work, fan out. If all four together would fit in one subagent in similar wall-clock, serialize them.

**Barriers (hard synchronization points):**
1. Phase 1 must be merged before dispatching 2A or 2B.
2. Both 2A AND 2B must be merged before starting Phase 3.
3. Phase 3 must be merged before Phase 4.

**Wall-clock parity rule:** do not fan out tasks where the parallel cold-start framing overhead (~50K tokens each) exceeds the serial speedup. For tasks estimated under ~5 minutes each, one subagent serializing them is often faster. Phase 2C (docs) is Sonnet-shaped and cheap to dispatch in parallel regardless of size.

**`di` ↔ `transformer` independence:** `@fnioc/di` is built and tested entirely with hand-fed tokens. The transformer is never invoked during 2A testing. This is the design property (from locked design §2) that makes the parallel tracks valid — they share only the ABI format defined in `core`, which is complete after Phase 1.

---

## Standing Tasks

### File issues to `rhombus-toolkit/ts`

During the `@rhombus-toolkit/*` reuse audit (per-use, not wholesale), file GitHub issues to `rhombus-toolkit/ts` for anything that is a genuine, well-justified problem found during the audit. **High bar:** the issue must be specific, actionable, and something that would benefit `rhombus-toolkit` consumers broadly — not a "nice to have" or something ioc can work around trivially. Write issues as the project author (no AI attribution); first-person, technical, direct. All `@rhombus-toolkit/*` packages are published except `fniterate`; verify publication before depending on any of them.

### ts-patch ↔ TS version compatibility

Verify the `ts-patch` version in `packages/transformer/package.json` supports the TypeScript version pinned in `mise.toml`. Document the tested pair. If a TS patch version upgrade is needed during development, update the pin in `mise.toml` (not system-wide) and re-run the compat check.

### CI monitoring discipline

Per user prefs: whenever a branch is pushed, a PR is opened, or a workflow is triggered that gates downstream automation (release-please, AUR publish, deploys), arm a Monitor in the same turn. Cover the full chain through the terminal state. Emit on every terminal state (success, failure, cancellation, `timed_out`) — not just success. Add in-script wedge detection (`last_change` timestamp; emit `WEDGE` and exit if no state change in 10–15 minutes). `PushNotification` on outcomes that change what needs to happen next.

---

## Progress Log

*(Append-only. Newest entries at the bottom.)*

- **2026-05-30** — Design locked (see `ioc-locked-design.md`). PRD drafted to `PRD.md`. PLAN drafted to `PLAN.md`. Repo directory exists at `~/src/ioc@rhombus-toolkit` (empty; no git init yet). All phases at ⬜.
- **2026-05-30** — Phase 0 scaffold complete locally: Bun + Moon + release-please, three package skeletons, real `tsc -b` → `dist` build, smoke tests. `moon run :lint :test :build` green locally. Repo created at `fnioc/ioc`, pushed to `main`; squash auto-merge + branch protection (require `verify`) enabled; publish job no-ops cleanly until `AUTOMERGE_PAT` is set. First CI run hit moon's genesis single-commit `HEAD~1` baseline error (no parent commit) — resolved by this second commit; every future push sits on existing history so it won't recur. **Blocker:** bw Vault server `hass4150.duckdns.org` unreachable → npm god token + `AUTOMERGE_PAT` retrieval deferred (only needed at Phase 4 publish).

---

## Risks & Blockers

**Blocker convention:** if any track gets stuck, append to `blockers.md` at the repo root — what was tried, what was learned, what is still unknown. Stop and surface it. Do not spin.

### Known risk points

| Risk | Phase | Mitigation |
|---|---|---|
| Phase 5 rename breaks Claude Code session anchor | 5 | Defer rename to the very end; use `fnc_switch_project` / `fnc_spawn_session` to re-anchor; delete old path if copy+transfer approach used |
| ts-patch ↔ TS version incompatibility | 2B / 4 | Pin both in `mise.toml`; verify the tested pair in Phase 2B.1; re-verify in Phase 4 before first publish |
| OIDC trusted-publisher bootstrap (first publish requires the config to exist before any publish attempt) | 4 | Set up trusted-publisher config on npmjs.com BEFORE triggering the first release-please merge; verify AUTOMERGE_PAT is set |
| `@fnioc` scope not yet claimed — another party could claim it before Phase 4 | 4 | Claim the scope (via Bitwarden rhombulus god token) at the START of Phase 4, before any publish attempt |
| Greedy overload selection + factory heuristic interaction (syntactic factory detection is at the transformer level, but the runtime partition is at resolve time) | 3 | Integration test explicitly covers the combined path in Phase 3 |
| Global-symbol WeakMap shared by two copies of `core` at the same ABI — correct by design, but subtle | 1 | Explicit two-copies-share-one-map unit test in Phase 1 checklist |
