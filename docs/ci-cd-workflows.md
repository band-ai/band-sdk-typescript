# CI/CD Workflows Guide

This document explains the GitHub Actions workflows and branch protection used in
this repository.

## Overview

The repository uses **GitHub Flow** with one canonical long-lived trunk:

```
feature branch ──(squash PR)──▶ main ──(merge release PR)──▶ release (npm)
```

- `main` — the single trunk. All feature work is squash-merged here, and it is
  also the release branch.
- There is no promotion hop. Release Please keeps a standing **release PR** up to
  date on `main`; merging that release PR is the deliberate "cut a release"
  action.

Because feature work and release commits live on the same branch, there is no
back-merge to reconcile after a release.

> **The `dev` branch is a compatibility lane, not a trunk.** CI continues to
> validate PRs targeting it so existing or mistakenly targeted work is not left
> without checks. Dependabot, Release Please, publishing, and all new work target
> `main`. Maintainers should retarget viable `dev` PRs to `main`; no release is
> ever cut from `dev`.

This repo is a **pnpm monorepo** publishing two packages, which is the main way
it differs from `band-ai/band-sdk-python`'s otherwise identical flow:

| Path | Published as |
|---|---|
| `packages/sdk` | `@band-ai/sdk` |
| `packages/openclaw` | `@band-ai/openclaw-channel-band` |

## Branch Protection (GitHub Rulesets)

Protection is enforced with GitHub Rulesets, not classic branch protection.

| Branch | Merge Method | Required Reviews | Stale Dismissed | Thread Resolution | Strict Checks | Merge Queue |
|--------|--------------|------------------|-----------------|-------------------|---------------|-------------|
| `main` | Squash (ordinary features) / Merge or approved history-preserving exception | 1 | Yes | Yes | No | No |

`main` blocks deletion and non-fast-forward (force) pushes.

**Intended required status check:** `ci-status` — and only that one.

The workflow provides this check, but repository rulesets are external state.
During rollout, first observe `ci-status` on this PR, then an administrator must
require that exact context in the live `main` ruleset and verify the setting.
Until that step is complete, this document must not be treated as proof that CI
is enforced by GitHub.

`ci-status` is an aggregate job that always runs and fails unless every other CI
job passed or was legitimately skipped. Requiring it instead of the individual
jobs matters for two reasons:

1. **Skipped jobs never report.** `lint` and `test` are gated behind a
   `dorny/paths-filter` result and are skipped when a PR touches no watched path.
   GitHub does not publish a check context for a skipped job, so requiring `lint`
   directly would leave a docs-only PR blocked forever on a check that can never
   arrive. `ci-status` always runs, so its context always arrives.
2. **The ruleset stops tracking job names.** Adding, renaming, or splitting a CI
   job needs no ruleset edit. A test in
   `scripts/release-hardening.test.mjs` asserts `ci-status` depends on every
   other job in `ci.yml`, so a new job cannot silently escape the gate.

Checks are deliberately **non-strict** (a PR branch need not be up to date with
`main` before merging), and there is **no merge queue**. Given this repo's PR
volume, the update-branch churn and per-merge queue latency cost more than they
buy. If concurrent-merge breakage ever becomes real, the escalation path is to
turn on strict checks and the merge queue — at which point `ci.yml` and
`pr-title.yml` both need a `merge_group:` trigger, and `pr-title.yml` needs its
validation step guarded with `if: github.event_name == 'pull_request'` (a merge
group carries no PR title), or the queue will deadlock.

## PR Workflows

### CI — `ci.yml`

Runs on every PR to `main` and, as a compatibility measure, every PR to `dev`.
Passing CI on `dev` does not make that branch releasable; viable work should be
retargeted to `main`.

- `changes` — `dorny/paths-filter` deciding which packages a PR touches. Any
  change to shared control paths (`.github/**`, `scripts/**`, `package.json`,
  `pnpm-workspace.yaml`, `pnpm-lock.yaml`, the release-please config/manifest,
  `.release-coordination.json`, `.release-hold`) selects **both** packages.
- `lint` — build, typecheck, and ESLint for each selected package.
- `test` — build and Vitest for each selected package, plus the release-hardening
  suite (`pnpm test:release-hardening`), which always runs.
- `packaging` — builds everything and verifies the published surface: the SDK's
  ESM and CJS entrypoints both import with non-empty exports, and OpenClaw's
  `dist` artifacts exist, are non-empty, and declare the expected exports.
- `ci-status` — the aggregate gate described above.

### PR Title — `pr-title.yml`

Validates the PR title against Conventional Commits (`Validate PR Title`).
Skipped for bot actors (dependabot, release-please). It is **not** a required
check; the squash-merge subject is what Release Please reads, so a wrong title
misfiles a changelog entry rather than breaking a build.

## Release Workflow

### Release — `release.yml`

Triggered on push to `main` (i.e. on every merge, and again when a release PR
merges). Runs in the `release` environment under `concurrency: release`.

1. **Determine release mode** — if a `.release-hold` file exists at the repo
   root, the run goes PR-only: Release Please still maintains the release PR, but
   `skip-github-release` suppresses tagging. This is the brake to pull during a
   rename or a half-finished migration.
2. **Release Please** opens/updates the release PR, or — when a release PR merges
   — tags the release and updates the changelogs and versions.
3. **Verify coordinated release outputs** (`scripts/assert-coordinated-release.mjs`)
   — both packages must release together, at exactly the versions pinned in
   `.release-coordination.json` while that migration guard exists. A partial
   release (one package only) or a
   version that misses its pinned target fails the run before anything reaches
   npm.
4. **Publish** — builds all packages, then publishes each released package to npm
   with `--provenance` via OIDC trusted publishing. Each publish re-checks
   `scripts/assert-release-ready.mjs` (the `.release-hold` guard) immediately
   before it runs.
5. **Summary** — reports the versions published.

> **Why `releases_created` is never used:** the plural output is broken in
> release-please v4 — it reports `true` even when no release occurred. Every gate
> in this workflow reads the per-package outputs
> (`packages/sdk--release_created`) instead. This is also why the action stays
> pinned to v4 rather than following the Python SDK to v5: the per-package output
> names this workflow depends on are v4's.

All actions in `release.yml` are pinned to full commit SHAs so a mutable release
tag cannot silently change the workflow that holds npm publishing rights.
Dependabot updates those SHAs. A test in `scripts/release-hardening.test.mjs`
fails the build if any action in this workflow is left on a floating tag.

### Release hardening tests — `scripts/release-hardening.test.mjs`

Run by `test` on every PR (`pnpm test:release-hardening`). It covers the
coordination and hold guards' behaviour, and asserts structural properties of the
workflows themselves: the hold check precedes Release Please, the coordination
check is unconditional and precedes any package work, every publish is preceded
by a readiness check, every action is SHA-pinned, CI validates both canonical
`main` and compatibility `dev` PRs while release automation targets only `main`,
and `ci-status` covers every job. These are the invariants that are easy to break
with a well-meaning workflow edit and impossible to notice until a release.

## Known gaps

Deliberately not addressed yet, recorded so they aren't rediscovered:

- **No tag protection ruleset.** Anyone with write access can create or move an
  `sdk-v*` / `openclaw-channel-band-v*` tag. The Python SDK restricts its
  `band-sdk-v*` namespace to the release App.
- **npm publish is inline in `release.yml`.** A post-tag failure can strand a
  tagged release unpublished, with no re-runnable recovery path short of a
  workflow dispatch of the whole release. The Python SDK splits publishing into a
  `release: published`-triggered workflow for exactly this reason; adopting that
  here requires updating the npm trusted-publisher config in lockstep, since it
  binds to the workflow filename.
- **`ci.yml` actions are still on floating tags.** Only `release.yml` is pinned,
  since that is the workflow with publishing rights.
- **`packages/sdk` is still named `@thenvoi/sdk` in `package.json`** and renamed
  to `@band-ai/sdk` by a `sed` at publish time. The rename belongs in the source.
