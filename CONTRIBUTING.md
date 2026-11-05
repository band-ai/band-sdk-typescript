# Contributing

Thanks for contributing to the Band TypeScript SDK.

This document covers the **branch, review, and release process**. For codebase
orientation — architecture, adapters, coding standards, and the full command
reference — see [`AGENTS.md`](AGENTS.md). The [CI/CD workflows](#ci-cd-workflows) section covers workflow and branch protection details.

## Development Setup

Requires Node `>=22.14.0` (the repo pins 22.22.2 in `.tool-versions`) and pnpm
(`packageManager` pins the version; `corepack enable` will honour it).

```bash
git clone https://github.com/band-ai/band-sdk-typescript.git
cd band-sdk-typescript
pnpm install
```

This is a pnpm workspace with three published packages:

| Path | Workspace name (use in `--filter`) | Published as |
|---|---|---|
| `packages/sdk` | `@band-ai/sdk` | `@band-ai/sdk` |
| `plugins/openclaw` | `@band-ai/openclaw-channel-band` | `@band-ai/openclaw-channel-band` |
| `plugins/claude-code` | `@band-ai/claude-code-plugin` | `@band-ai/claude-code-plugin` |

> Every package publishes under its workspace name; no publish-time package
> rename is applied. Use the workspace name for `pnpm --filter`.

## Development Workflow

1. **Create a feature branch**

   Branch off `main` (the single long-lived trunk):

   ```bash
   git checkout main && git pull
   git checkout -b feat/your-feature-name
   # or
   git checkout -b fix/your-bug-fix
   ```

   Use branch prefixes: `feat/`, `fix/`, `chore/`, `ci/`, `docs/`, `refactor/`.

   > **Do not start new work from `dev`.** It is a compatibility lane for older
   > or mistakenly targeted PRs: CI still validates those PRs, but Dependabot,
   > releases, and new development target `main`. See
   > [CI/CD workflows](#ci-cd-workflows) for the history.

2. **Make your changes**

   Follow the engineering standard and relevant skills in [`AGENTS.md`](AGENTS.md).
   Plan the change, establish the owning cause or need, and assess meaningful
   coverage of realistic flows before implementation.

3. **Run the applicable checks**

   Select validation using [AGENTS.md](AGENTS.md#pre-commit-checklist). Prose-only
   changes need documentation/skill checks, not the SDK unit suite. The full
   workspace gate for shared behavior, dependencies and packaging is:

   ```bash
   pnpm -r lint
   pnpm typecheck
   pnpm test
   ```

   The root test and typecheck commands build the SDK once before checking
   the workspace. Plugin scripts operate on that build rather than rebuilding
   shared output in parallel. For a plugin-only build, include its dependencies:

   ```bash
   pnpm --filter @band-ai/claude-code-plugin... build
   pnpm --filter @band-ai/openclaw-channel-band... build
   ```

   If you touched anything under `.github/`, `scripts/`, or the release
   configuration, also run the release-hardening suite:

   ```bash
   pnpm test:release-hardening
   ```

   Useful narrower commands:

   ```bash
   pnpm --filter @band-ai/sdk test
   pnpm --filter @band-ai/sdk exec vitest run path/to/file.test.ts
   pnpm --filter @band-ai/sdk run coverage
   ```

   The suite is expected to be **green on Windows, macOS, and Linux alike**. A
   few tests skip themselves when the environment genuinely cannot run them, and
   they say so rather than failing:

   - the SQLite store tests need `node:sqlite`, which is unflagged only from Node
     22.13 (the pinned toolchain is well past that, so they normally run);
   - the release-publisher tests in `scripts/release-hardening.test.mjs` drive a
     `#!/bin/sh` npm stub and are skipped off POSIX.

   Anything else red is a real failure — please do not merge past it. Some proofs
   compile a consumer against `dist/`, so run a build first if you are iterating
   on them directly.

4. **Commit your changes**

   Write commit messages following
   [Conventional Commits](https://www.conventionalcommits.org/) — Release Please
   reads them to decide the next version and build the changelog. Use only the
   types and scopes listed in
   [`.github/workflows/pr-title.yml`](.github/workflows/pr-title.yml); the scope
   is optional, so leave it out rather than invent one:

   ```bash
   git commit -m "feat(sdk): add event streaming support"
   git commit -m "fix(openclaw): resolve mention lookup for renamed rooms"
   ```

   `feat:` scores a MINOR bump, `fix:` a PATCH, and a `!` or `BREAKING CHANGE:`
   footer a MAJOR. `chore:`, `ci:`, `test:`, `build:`, `refactor:`, and `style:`
   are hidden from the changelog.

5. **Submit a pull request**

   Push your branch and open a **draft** PR against **`main`**. Complete the
   [author readiness review](AGENTS.md#pr-lifecycle-and-readiness-review) before
   marking it ready: supported problem analysis, a proportional plan, complete
   implementation, meaningful scenario coverage, and applicable validation.
   Use the [Why / What / Scope format](AGENTS.md#pull-request-descriptions).
   Draft CI skips do not waive author checks; ready does not mean approved.

   Every PR is **squash-merged**
   through the merge queue, so the squash subject is what Release Please sees —
   make sure it is a valid Conventional Commit (CI validates the PR title for you).

   Requirements to merge: one approving review from a code owner
   (`.github/CODEOWNERS`; code owners' own PRs need none), all review threads
   resolved, and the `ci-status` and `Validate PR Title` checks green. The queue
   then re-runs those checks against the latest `main` before merging.

## Pull Request Guidelines

1. Keep PRs focused and atomic
2. Update documentation if needed
3. Add tests for new functionality
4. Reference related issues in the PR description
5. Use proper PR title format (validated by CI)

Do not put issue-tracker references (Linear IDs, ticket numbers, URLs) in source
code — branch names, commit messages, and PR descriptions are the right place.

## Release Process

This project uses [Release Please](https://github.com/googleapis/release-please)
for automated releases on a single trunk (`main`) — there is no separate release
branch to promote to. Releases follow [Semantic Versioning](https://semver.org/):

- **MAJOR**: Breaking changes
- **MINOR**: New backward-compatible features
- **PATCH**: Bug fixes

Every releasable merge to `main` updates a standing **release PR** (the version
bumps + changelogs) that Release Please maintains; non-release commit types may
produce no update. Nothing publishes until a maintainer merges that release PR.
Merging it tags whichever package releases are ready and triggers `release.yml`,
which publishes each selected package independently to npm with provenance.

Release PRs merge through the queue like any other PR (squash). The safety
guard also compares the full PR or push range against its authoritative base
SHA, so a multi-commit topology cannot hide an earlier version transition.

### Independent package releases

`@band-ai/sdk`, `@band-ai/openclaw-channel-band` and `@band-ai/claude-code-plugin`
release independently. Release intent requires each selected package's manifest
and package metadata to transition atomically; a plugin's manifest version is
part of its own atomic transition. A release may contain any subset of the
packages, at unrelated stable versions. A package new since the release baseline
must have matching stable versions, and the release hold applies to adding it.

### Holding releases

Creating a `.release-hold` file at the repo root puts the pipeline in PR-only
mode: Release Please keeps the release PR current, but nothing is tagged or
published. Use it while a rename or migration is mid-flight. **Do not merge the
release PR while the hold exists**: CI rejects any held version transition before
merge, and the release workflow checks the same invariant before tag creation.
Delete the hold in the reviewed release PR only when the migration is ready.

If an npm publish fails, don't just re-run the failed `publish` job: the
uploaded artifact is retained for only 1 day, so a re-run after that window
fails at the download step with nothing to recover. Instead, manually run the
Release workflow from `main`, select exactly one `recover-package` (a `key` in
`scripts/release-packages.mjs`: `sdk`, `openclaw` or `claude-code`), and set `release-commit` to the exact 40-character SHA carrying
that package's release tag. Recovery verifies the commit is reachable from
`main`, checks out those exact bytes, confirms only the selected package's
current metadata and tag, skips an exact version already present on npm, and
publishes only that package. Recovery runs the release scripts of that commit,
so it only works for releases tagged after `scripts/release-packages.mjs` landed.

For an ordinary manual Release Please run, leave `recover-package` set to
`automatic` and leave `release-commit` empty. Push-triggered runs supply an empty
selector and follow the same ordinary path.

### Hotfixes

An urgent fix follows the same single-trunk path as any other change — there is
no separate hotfix or release branch to cherry-pick between:

1. Branch off the latest `main` (e.g. `fix/...`) and write the fix as a `fix:`
   commit so Release Please scores a **PATCH** bump.
2. Open a PR to `main`, get it reviewed and merged (squash) like normal — CI and
   branch protection still apply; don't bypass them.
3. Release Please updates the standing release PR with the affected package's
   patch bump. To ship
   immediately, merge that release PR right away; `release.yml` then tags and
   publishes the patch. (Leaving it unmerged just means the fix ships with the
   next release.)

Because `main` is the only long-lived branch, the hotfix and its release land on
the same line of history — there is nothing to back-port afterward.

## Getting Help

- Open an issue for bugs or feature requests
- Check existing issues before creating new ones
- Join discussions in pull requests

Thank you for contributing!

## CI/CD workflows

This document explains the GitHub Actions workflows and branch protection used in
this repository.

### Overview

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

This repo is a **pnpm monorepo** publishing three packages. Its branch topology
mirrors `band-ai/band-sdk-python`, while its release workflow remains tailored
to this repository's independent multi-package release:

| Path | Published as |
|---|---|
| `packages/sdk` | `@band-ai/sdk` |
| `plugins/openclaw` | `@band-ai/openclaw-channel-band` |
| `plugins/claude-code` | `@band-ai/claude-code-plugin` |

`scripts/release-packages.mjs` is the one list of released packages (path,
npm name, version files, packlist floor) that every release script and
`release.yml` step reads. A new package needs an entry there plus its
`release-please-config.json` and `.release-please-manifest.json` entries, a
`recover-package` option in `release.yml`, and in `ci.yml` a path filter that
includes `*shared` plus its typecheck, lint and test steps.

### Branch Protection (GitHub Rulesets)

Protection is enforced with GitHub Rulesets, not classic branch protection.

| Branch | Merge Method | Required Reviews | Stale Dismissed | Thread Resolution | Strict Checks | Merge Queue |
|--------|--------------|------------------|-----------------|-------------------|---------------|-------------|
| `main` | Squash, through the merge queue | 1 from a code owner | Yes | Yes | Yes | Yes |

`main` blocks deletion and non-fast-forward (force) pushes. Two rulesets split
the policy:

- `main-branch-protection` — merge queue, required checks, no deletion or force
  push.
  Nobody but org admins can bypass it.
- `main-code-owner-review` — one approval from a code owner
  (`.github/CODEOWNERS`) and resolved threads. Code owners are *exempt*, so their
  own PRs need no review; they still go through the queue and its checks.

Every PR, release PRs included, is squash-merged by the queue. The
release-intent check independently compares the full PR or push range against
GitHub's authoritative base SHA, preventing an earlier commit in a multi-commit
topology from hiding a version transition.

**Required status checks:** `ci-status` and `Validate PR Title`. CodeQL gates
PRs through the ruleset's code scanning rule instead of a status check, because
that rule does not apply to merge groups, where CodeQL default setup never runs.

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
   mandatory and must succeed, so a draft PR, which runs no CI, shows a red
   `ci-status`. `ci-status` encodes that distinction and always reports one
   stable context.
2. **The ruleset stops tracking job names.** Adding, renaming, or splitting a CI
   job needs no ruleset edit. A test in
   `scripts/release-hardening.test.mjs` asserts `ci-status` depends on every
   other job in `ci.yml` and checks each one's result, so a new job cannot
   silently escape the gate.

#### Strict checks

Checks are **strict**: a PR branch must be up to date with `main` before it
merges. This guards against semantic conflicts — two PRs that each pass alone and
break once combined, with no textual conflict for git to catch. The `C3`–`C7`
guards assert over global state (export-surface snapshots, whole-tree text scans,
byte-identical migration-map regeneration), so that failure mode is realistic here rather
than theoretical.

#### Merge queue

The queue re-runs the required checks on each PR combined with everything queued
ahead of it, so two PRs that pass alone but break together never both land. Both
`ci.yml` and `pr-title.yml` therefore trigger on `merge_group:`, and
`pr-title.yml` guards its validation step with
`if: github.event_name == 'pull_request'` — a merge group carries no PR title, so
without that guard the queue deadlocks. `typescript-core-coverage.yml` is not a
required check and does not run in the queue.

Dependabot PRs go stale on every merge to `main`. Dependabot rebases its own
branches, so this is visible noise rather than work.

### PR Workflows

#### CI — `ci.yml`

The mandatory `packaging` job runs the existing repository-wide content guards
before building packages, even when PR path filters select no package. These
guards read tracked source, documentation and agent guidance outside package
directories. This keeps a docs-only PR from passing its PR checks and first
revealing a content violation in the merge queue. The full SDK suite remains
path-filtered on PRs and runs in the queue.

Runs on every PR to `main` and, as a compatibility measure, every PR to `dev`.
Passing CI on `dev` does not make that branch releasable; viable work should be
retargeted to `main`.

It also runs on every **merge group**, so a change is validated against the
latest trunk before it lands. `main` fast-forwards to the exact commit the queue
validated, so CI does not run again on a push to `main`. Three details make the
queue run the real verdict for `main`:

- **Path filtering is skipped.** `dorny/paths-filter` runs only on pull
  requests; in a merge group every package output is forced `true`, so the
  queue exercises the whole tree, not the slice one PR happened to touch —
  otherwise `ci-status` could go green having skipped `lint` and `test`.
- **Queue runs are not cancelled.** `cancel-in-progress` is on for pull requests
  only. Superseding a PR run is free; superseding a merge-group run would leave
  the commit that lands with no verdict at all. Each merge-group run also gets
  its own concurrency group (`github.run_id`): a PR requeued on the same base
  reuses its `gh-readonly-queue/...` ref, so a ref-keyed group would hold the
  new run pending behind the old one.
- **Release intent is PR-only.** `assert-release-intent.mjs` is a merge gate and
  needs `github.event.pull_request.base.sha` as its baseline. A merge group has
  no such baseline, and the PR run already gated it.

`scripts/release-hardening.test.mjs` asserts each of these.

The workflow-level `GITHUB_TOKEN` is least-privilege: `contents: read` supports
checkout and `pull-requests: read` supports changed-file detection. CI receives
no write permission.

- `changes` — `dorny/paths-filter` deciding which packages a PR touches. Any
  change to shared control paths (`.github/**`, `scripts/**`, `package.json`,
  `pnpm-workspace.yaml`, `pnpm-lock.yaml`, the release-please config/manifest,
  `.release-hold`) selects **every** package: they are listed once under the
  `&shared` YAML anchor, and each package filter includes `*shared`. The `any`
  output gates what every selected package shares.
- `lint` — build, typecheck, and ESLint for each selected package.
- `test` — checks release intent before Release Please can consume a version
  transition, then builds and runs Vitest for each selected package plus the
  release-hardening suite (`pnpm test:release-hardening`).
- `packaging` — builds everything and verifies the published surface: every
  listed package's packlist meets its `contents` entry in
  `scripts/release-packages.mjs`, the SDK's ESM and CJS entrypoints both import
  with non-empty exports, OpenClaw's `dist` artifacts are non-empty and declare
  the expected exports, and `claude plugin validate --strict` accepts the Claude
  Code plugin.
- `ci-status` — the aggregate gate described above.

#### PR Title — `pr-title.yml`

Validates the PR title against Conventional Commits (`Validate PR Title`),
accepting only the `types:` and `scopes:` listed in the workflow. It is the one
place those lists live, so change them there.
Skipped for bot actors (dependabot, release-please). It is a required check:
the squash-merge subject is what Release Please reads, so a wrong title would
misfile a changelog entry. In a merge group there is no title, so the validation
step is skipped and the job reports success.

### Release Workflow

#### Release — `release.yml`

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
   rejected while held. Each listed package's manifest version and version files
   transition atomically and independently of the others. The baseline side
   finds each package by its Release Please `package-name`, so a package that
   moved paths is compared with its old location. CI runs the same
   check so a held or inconsistent package release cannot merge once `ci-status`
   is required.
3. **Release Please** opens/updates the release PR, or — when a release PR merges
   — tags the release and updates the changelogs and versions.
4. **Resolve release state** (`scripts/resolve-release-state.mjs`) — writes the
   packages this run releases, in list order, to the `packages` output. Normal
   runs read Release Please's per-package outputs: each created flag is parsed
   fail-closed and each selected version must be a stable semantic version. Any
   subset of the listed packages may be selected.
5. **Build artifacts** — Manual ordinary runs select `recover-package: automatic`;
   push events provide an empty selector and behave identically. A manual run
   from `main` with one package-specific `recover-package` selection also
   requires the exact 40-character `release-commit`. The workflow verifies that
   revision is reachable from
   `main`, checks out the commit, requires the selected package's release tag to
   resolve to exactly those bytes, validates only that package's current
   manifest version and version files, and selects only it for recovery.
   With no OIDC permission, this job installs dependencies, builds all packages,
   checks each selected package's npm packlist against its listed floor and
   entries and packs it (`scripts/pack-release.mjs`), and uploads the bundle with a 1-day
   retention. Re-running the `publish` job after that window fails at the
   download step, since the artifact is gone; the supported recovery is a
   `recover-package` dispatch, which re-packs from the tagged release commit
   instead of reusing the expired artifact.
6. **Publish** — a separate environment-gated job, run once per selected package
   (one at a time, in list order), receives OIDC permission,
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

> **Per-package outputs are keyed by path.** Release state reads
> `<path>--release_created` and `<path>--version` for each listed `path`
> (`packages/sdk--release_created`), never the plural `releases_created`. Release
> Please continues a moved package's versions from its manifest entry and
> component name, not its old path, so a move only updates the list, the config
> and the manifest key.

All actions in `release.yml` are pinned to full commit SHAs so a mutable release
tag cannot silently change the workflow that holds npm publishing rights.
Dependabot updates those SHAs. A test in `scripts/release-hardening.test.mjs`
fails the build if any action in this workflow is left on a floating tag.

#### Release hardening tests — `scripts/release-hardening.test.mjs`

Run by `test` on every PR (`pnpm test:release-hardening`). It covers the
independent output, intent, recovery, and hold guards' behaviour, and asserts structural properties of the
workflows themselves: the hold check precedes Release Please, the release
intent check precedes release creation, the output check is unconditional and
precedes package work, every publish is recoverable and preceded by a readiness
check, every release action and the npm version are pinned, CI validates both canonical
`main` and compatibility `dev` PRs while release automation targets only `main`,
and `ci-status` covers every job. These are the invariants that are easy to break
with a well-meaning workflow edit and impossible to notice until a release.

### Known gaps

Deliberately not addressed yet, recorded so they aren't rediscovered:

- **No tag protection ruleset.** Anyone with write access can create or move an
  `sdk-v*` / `openclaw-channel-band-v*` / `claude-code-plugin-v*` tag. The Python SDK restricts its
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
- **Recovery runs the release scripts of the commit it recovers.** A recovery
  dispatch checks out `release-commit` before resolving, packing and publishing,
  so it only works for release commits that contain `scripts/release-packages.mjs`
  and the `plugins/openclaw` layout (INT-1663). Every release tagged before that
  (through `sdk-v0.5.0` and `openclaw-channel-band-v0.3.2`) was already on npm
  when it landed.
- **This pipeline is stable-releases-only, by choice.** `assert-release-intent.mjs`
  and `resolve-release-state.mjs` both require `^\d+\.\d+\.\d+$`, so a
  prerelease version is rejected by the guards, not merely unsupported by
  convention. Adding a prerelease channel is more than loosening that regex:
  `publish-if-needed.mjs` publishes with no `--tag`, so every publish already
  lands on npm's `latest`; a prerelease would need dist-tag routing added
  first, or it would overwrite `latest` with an `rc`/`beta`.
