# ioc — project policy

## Two-stage publish

Releases ship in two stages. The first is automatic; the second is never.

- **`@next` (automatic).** Every release-please release publishes each released
  package to the npm `@next` dist-tag via `ci.yml`, authenticated by an OIDC
  trusted publisher (no token). `@next` is the only tag that publishes
  automatically.
- **`@latest` (manual).** Promotion from `@next` to `@latest` happens only via
  the `promote` workflow (`promote.yml`, `workflow_dispatch`). `@latest` is
  never set automatically — a release reaches it only when someone runs the
  promote workflow.

## release-please

release-please opens **per-package** release PRs (`separate-pull-requests`,
per-package tags like `core-v1.2.3`). `auto-merge.yml` **excludes** them — its
job `if:` skips any PR whose head branch starts with `release-please--`. So
release PRs are *not* auto-merged; they stand open and accumulate until
deliberately merged at wrap-up.

## Merging the release PR cuts the `@next` release

The standing release PR is the release trigger. Merging it sends it through the
merge queue; release-please cuts the per-package tag(s) + GitHub Release, and
`ci.yml` publishes the released packages to `@next`. Nothing else cuts a `@next`
build — and because release PRs are excluded from auto-merge (above), cutting a
release is always a deliberate manual merge, never automatic.

## main is merge-queue governed

`main` is governed by a GitHub ruleset with a **required merge queue**. Every PR
(including release PRs) is tested against an up-to-date `main` before it lands —
no PR merges without passing `verify` in queue.

## Auth split

- **`@next` publish** — OIDC trusted publisher, no token. The trusted-publisher
  config on npmjs.com pins the workflow filename, so `ci.yml` must keep that
  name (load-bearing — do not rename).
- **`@latest` promote** — `NPM_TOKEN` secret. `npm dist-tag` is not covered by
  OIDC trusted publishing, so `promote.yml` authenticates with a token.
