# CI/CD Workflows Guide

This document explains the GitHub Actions workflows and branch protection used in
this repository.

## Overview

The repository uses **GitHub Flow** with one canonical long-lived trunk:

```
feature branch ──(squash PR)──▶ main ──(merge release PR)──▶ release (npm)
```

- `main` — the single trunk. Ordinary feature work is squash-merged here, and it is
  also the release branch.
- There is no promotion hop. Release Please keeps a standing **release PR** up to
  date on `main`; merging that release PR is the deliberate "cut a release"
  action.

Because feature work and release commits live on the same branch, there is no
back-merge to reconcile after a release.

> **The `dev` branch is a compatibility lane, not a trunk.** CI continues to
> validate PRs targeting it so existing or mistakenly targeted work is not left
> without checks. Dependabot, Release Please, publishing, and all new work target
> `main`. Existing `dev` PR migration is outside this rollout; no release is ever
> cut from `dev`.

This repo is a **pnpm monorepo** publishing two packages. Its branch topology
mirrors `band-ai/band-sdk-python`, while its release workflow remains tailored
to this repository's independent multi-package release:

| Path | Published as |
|---|---|
| `packages/sdk` | `@band-ai/sdk` |
| `packages/openclaw` | `@band-ai/openclaw-channel-band` |

## Branch Protection (GitHub Rulesets)

Protection is enforced with GitHub Rulesets, not classic branch protection.

| Branch | Merge Method | Required Reviews | Stale Dismissed | Thread Resolution | Strict Checks | Merge Queue |
|--------|--------------|------------------|-----------------|-------------------|---------------|-------------|
| `main` | Squash (ordinary features) / Merge or approved history-preserving exception | 1 | Yes | Yes | Yes | No |

`main` blocks deletion and non-fast-forward (force) pushes.

Release PRs must use a merge commit or squash merge, never rebase merge. The
release-intent check independently compares the full PR or push range against
GitHub's authoritative base SHA, preventing an earlier commit in a multi-commit
topology from hiding a version transition.

**Required status check:** `ci-status` — and only that one.

Rulesets are external GitHub state that no file in this repository can assert, so
this section describes the intended configuration rather than proving what is
live. Check the real thing with
`gh api repos/band-ai/band-sdk-typescript/rulesets`.

`ci-status` is an aggregate job that always runs and fails unless every other CI
job passed or was legitimately skipped. Requiring it instead of the individual
jobs matters for two reasons:

1. **One policy distinguishes mandatory and conditional work.** GitHub reports a
   job skipped by a job-level condition as successful. `lint` and `test` are
   intentionally conditional and may be skipped; `changes` and `packaging` are
   mandatory and must succeed. `ci-status` encodes that distinction and always
   reports one stable context.
2. **The ruleset stops tracking job names.** Adding, renaming, or splitting a CI
   job needs no ruleset edit. A test in
   `scripts/release-hardening.test.mjs` asserts `ci-status` depends on every
   other job in `ci.yml`, so a new job cannot silently escape the gate.

### Strict checks

Checks are **strict**: a PR branch must be up to date with `main` before it
merges. This guards against semantic conflicts — two PRs that each pass alone and
break once combined, with no textual conflict for git to catch. The `C3`–`C7`
guards assert over global state (export-surface snapshots, whole-tree text scans,
byte-identical doc regeneration), so that failure mode is realistic here rather
than theoretical.

There is **no merge queue**, so on a busy day a branch can go stale between
updating and merging and the update is simply retried. If that becomes a real
cost, adding the queue means giving `ci.yml` and `pr-title.yml` both a
`merge_group:` trigger and guarding `pr-title.yml`'s validation step with
`if: github.event_name == 'pull_request'` — a merge group carries no PR title, so
without that guard the queue deadlocks.

Dependabot PRs go stale on every merge to `main`. Dependabot rebases its own
branches, so this is visible noise rather than work.

## PR Workflows

### CI — `ci.yml`

Runs on every PR to `main` and, as a compatibility measure, every PR to `dev`.
Passing CI on `dev` does not make that branch releasable; viable work should be
retargeted to `main`.

It also runs on every **push to `main`**, so the trunk is re-validated after a
merge. Without that trigger the suite only ever saw a PR's merge commit: a red
build that landed anyway stopped being reported the moment it merged, and "CI is
green on `main`" said nothing about `main`'s actual tree. Three details make the
trunk run meaningful rather than decorative:

- **Path filtering is skipped.** `dorny/paths-filter` runs only on pull
  requests; on a push both package outputs are forced `true`. Trunk validation
  exercises the whole tree, not the slice one merge happened to touch —
  otherwise `ci-status` could go green having skipped `lint` and `test`.
- **Runs are not cancelled.** `cancel-in-progress` is on for pull requests only.
  Superseding a PR run is free; superseding a trunk run would leave that commit
  of `main` with no verdict at all.
- **Release intent is PR-only.** `assert-release-intent.mjs` is a merge gate and
  needs `github.event.pull_request.base.sha` as its baseline. A push has no such
  baseline, and the merge it would gate has already happened.

`scripts/release-hardening.test.mjs` asserts each of these, so the trunk trigger
cannot be quietly removed or hollowed out.

The workflow-level `GITHUB_TOKEN` is least-privilege: `contents: read` supports
checkout and `pull-requests: read` supports changed-file detection. CI receives
no write permission.

- `changes` — `dorny/paths-filter` deciding which packages a PR touches. Any
  change to shared control paths (`.github/**`, `scripts/**`, `package.json`,
  `pnpm-workspace.yaml`, `pnpm-lock.yaml`, the release-please config/manifest,
  `.release-hold`) selects **both** packages.
- `lint` — build, typecheck, and ESLint for each selected package.
- `test` — checks release intent before Release Please can consume a version
  transition, then builds and runs Vitest for each selected package plus the
  release-hardening suite (`pnpm test:release-hardening`).
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
merges) or by an explicit manual recovery dispatch on `main`. The job rejects a
selected non-main ref in workflow code. Repository administrators must also
restrict the live `release` environment to the `main` branch; that external
policy is a rollout requirement, not something this workflow file can enforce.
Runs under `concurrency: release`.

The build/release job's `GITHUB_TOKEN` is read-only and has no OIDC capability.
Release Please receives a repository-scoped GitHub App token explicitly
limited to contents and pull-request writes rather than inheriting every
installation permission. A separate minimal publish job receives `id-token:
write`; it never installs dependencies or runs project build code.

1. **Determine release mode** — if a `.release-hold` file exists at the repo
   root, the run goes PR-only: Release Please still maintains the release PR, but
   `skip-github-release` suppresses tagging. This is the brake to pull during a
   rename or a half-finished migration.
2. **Verify release intent** (`scripts/assert-release-intent.mjs`) — ordinary
   commits pass without a version transition. A release-version transition is
   rejected while held. SDK manifest/package metadata transitions atomically and
   independently from OpenClaw manifest/package/plugin metadata. CI runs the same
   check so a held or inconsistent package release cannot merge once `ci-status`
   is required.
3. **Release Please** opens/updates the release PR, or — when a release PR merges
   — tags the release and updates the changelogs and versions.
4. **Verify independent release outputs** (`scripts/assert-release-outputs.mjs`)
   — each created flag is parsed fail-closed and each selected version must be a
   stable semantic version. Zero, one, or both packages may be selected.
5. **Resolve release state and build artifacts** — normal runs use Release Please's
   package outputs. Manual ordinary runs select `recover-package: automatic`;
   push events provide an empty selector and behave identically. A manual run
   from `main` with one package-specific `recover-package` selection also
   requires the exact 40-character `release-commit`. The workflow verifies that
   revision is reachable from
   `main`, checks out the commit, requires the selected package's release tag to
   resolve to exactly those bytes, validates only that package's current
   manifest/package/plugin metadata, and selects only it for recovery.
   With no OIDC permission, this job installs dependencies, builds both packages,
   packs the selected package tarballs, and uploads the bundle with a 1-day
   retention. Re-running the `publish` job after that window fails at the
   download step, since the artifact is gone; the supported recovery is a
   `recover-package` dispatch, which re-packs from the tagged release commit
   instead of reusing the expired artifact.
6. **Publish** — a separate environment-gated job receives OIDC permission,
   downloads the prebuilt bundle, and runs no dependency install or project
   build. Its exact Node 24.18.1 runtime bundles npm 11.16.0, so the job does not
   install executable tooling after receiving OIDC authority. Tarball publication
   also uses `--ignore-scripts`, preventing package lifecycle code from executing
   with OIDC access. Immediately before each package's npm access, the job fetches
   current `origin/main` and re-checks `scripts/assert-release-ready.mjs`
   against both the selected release source and that authoritative current
   branch, so a newly activated `.release-hold` stops pending recovery before it
   runs. `scripts/publish-if-needed.mjs` first queries the exact package
   version: an already-published version is treated as successful recovery, a
   confirmed 404 publishes, and an inconclusive lookup fails closed.
7. **Summary** — reports the versions published.

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
independent output, intent, recovery, and hold guards' behaviour, and asserts structural properties of the
workflows themselves: the hold check precedes Release Please, the release
intent check precedes release creation, the output check is unconditional and
precedes package work, every publish is recoverable and preceded by a readiness
check, every release action and the npm version are pinned, CI validates both canonical
`main` and compatibility `dev` PRs while release automation targets only `main`,
and `ci-status` covers every job. These are the invariants that are easy to break
with a well-meaning workflow edit and impossible to notice until a release.

## Known gaps

Deliberately not addressed yet, recorded so they aren't rediscovered:

- **No tag protection ruleset.** Anyone with write access can create or move an
  `sdk-v*` / `openclaw-channel-band-v*` tag. The Python SDK restricts its
  `band-sdk-v*` namespace to the release App. Until administrators add equivalent
  protection, recovery is a trusted-maintainer operation: the approver must
  compare `release-commit` with the original release run before authorizing the
  environment deployment; tag alignment alone is not immutable proof.
- **npm publish remains inline in `release.yml`.** Manual dispatch on `main` with
  a package-specific recovery selection and the exact tagged `release-commit`
  can recover a partial publish because
  exact versions already present on npm are skipped, but release creation and publication are still coupled in one
  workflow. The Python SDK separates them; adopting that architecture here
  requires updating the affected npm trusted-publisher binding.
- **`ci.yml` actions are still on floating tags.** Only `release.yml` is pinned,
  since that is the workflow with publishing rights.
- **`packages/sdk` is named `@band-ai/sdk` in `package.json`** and publishes
  under that name; no publish-time `sed` rename is applied.
- **A manual `automatic` dispatch validates a narrower range than a push.** The
  release-intent baseline is `github.event.before` on a push (the real
  previously-deployed commit), but a manual dispatch has no such event field,
  so it deliberately checks only the immediate parent commit (`HEAD^`). A
  multi-commit range assembled entirely through manual dispatches is therefore
  checked one commit at a time rather than against the full range a push would
  cover. Not a silent gap — the baseline is resolved and named explicitly in
  its own workflow step — but it is weaker, and this is that trade-off on the
  record.
- **This pipeline is stable-releases-only, by choice.** `assert-release-intent.mjs`
  and `assert-release-outputs.mjs` both require `^\d+\.\d+\.\d+$`, so a
  prerelease version is rejected by the guards, not merely unsupported by
  convention. Adding a prerelease channel is more than loosening that regex:
  `publish-if-needed.mjs` publishes with no `--tag`, so every publish already
  lands on npm's `latest`; a prerelease would need dist-tag routing added
  first, or it would overwrite `latest` with an `rc`/`beta`.
