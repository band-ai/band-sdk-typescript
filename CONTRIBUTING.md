# Contributing

Thanks for contributing to the Band TypeScript SDK.

This document covers the **branch, review, and release process**. For codebase
orientation — architecture, adapters, coding standards, and the full command
reference — see [`AGENTS.md`](AGENTS.md). For the workflows and branch protection
behind the process described here, see
[`docs/ci-cd-workflows.md`](docs/ci-cd-workflows.md).

## Development Setup

Requires Node `>=22.14.0` (the repo pins 22.22.2 in `.tool-versions`) and pnpm
(`packageManager` pins the version; `corepack enable` will honour it).

```bash
git clone https://github.com/band-ai/band-sdk-typescript.git
cd band-sdk-typescript
pnpm install
```

This is a pnpm workspace with two published packages:

| Path | Workspace name (use in `--filter`) | Published as |
|---|---|---|
| `packages/sdk` | `@thenvoi/sdk` | `@band-ai/sdk` |
| `packages/openclaw` | `@band-ai/openclaw-channel-band` | `@band-ai/openclaw-channel-band` |

> The SDK's local name is still `@thenvoi/sdk`; `release.yml` rewrites it to
> `@band-ai/sdk` at publish time. Use the workspace name for `pnpm --filter`.

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
   > [`docs/ci-cd-workflows.md`](docs/ci-cd-workflows.md) for the history.

2. **Make your changes**

   Follow the coding standards in [`AGENTS.md`](AGENTS.md).

3. **Run the checks**

   ```bash
   pnpm -r lint
   pnpm -r typecheck
   pnpm -r test
   ```

   If you touched anything under `.github/`, `scripts/`, or the release
   configuration, also run the release-hardening suite:

   ```bash
   pnpm test:release-hardening
   ```

   Useful narrower commands:

   ```bash
   pnpm --filter @thenvoi/sdk test
   pnpm --filter @thenvoi/sdk exec vitest run path/to/file.test.ts
   pnpm --filter @thenvoi/sdk run coverage
   ```

4. **Commit your changes**

   Write commit messages following
   [Conventional Commits](https://www.conventionalcommits.org/) — Release Please
   reads them to decide the next version and build the changelog:

   ```bash
   git commit -m "feat(sdk): add event streaming support"
   git commit -m "fix(openclaw): resolve mention lookup for renamed rooms"
   ```

   `feat:` scores a MINOR bump, `fix:` a PATCH, and a `!` or `BREAKING CHANGE:`
   footer a MAJOR. `chore:`, `ci:`, `test:`, `build:`, `refactor:`, and `style:`
   are hidden from the changelog.

5. **Submit a pull request**

   Push your branch and open a PR against **`main`**. Ordinary PRs are **squash-merged**,
   so the squash subject is what Release Please sees — make sure it is a valid
   Conventional Commit (CI validates the PR title for you).

   Requirements to merge: one approving review, all review threads resolved, and
   the `ci-status` check green once the repository ruleset rollout is complete.
   Until then, maintainers must verify it manually; merging this file does not
   change GitHub's external ruleset.

   A reviewed migration plan may explicitly require preserved commits for
   bisectability or staged proof. Such a PR is an exception to squash merging and
   must use an allowed history-preserving merge method documented in that plan.

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
Merging it tags the release and triggers `release.yml`, which publishes both
packages to npm with provenance.

Merge release PRs with a merge commit or squash merge, never rebase merge, so
the release remains easy to audit. The safety guard also compares the full PR or
push range against its authoritative base SHA, so a multi-commit topology cannot
hide an earlier version transition.

### Coordinated release guard

While `.release-coordination.json` exists, `@band-ai/sdk` and
`@band-ai/openclaw-channel-band` must release as a coordinated pair. The exact
next version of each is pinned in that file, and
`scripts/assert-coordinated-release.mjs` fails the release if only one package
would publish or if either version misses its pinned target. The rename plan
keeps this temporary migration guard through the coordinated install proof and
removes it in a separately reviewed cleanup PR; permanent lockstep releases are
not implied.

**So: when you change the expected next versions, update
`.release-coordination.json` in the same PR.** Its expected contents are asserted
by `scripts/release-hardening.test.mjs`, so a mismatch fails CI rather than the
release.

### Holding releases

Creating a `.release-hold` file at the repo root puts the pipeline in PR-only
mode: Release Please keeps the release PR current, but nothing is tagged or
published. Use it while a rename or migration is mid-flight. **Do not merge the
release PR while the hold exists**: CI rejects any held version transition before
merge, and the release workflow checks the same invariant before tag creation.
Delete the hold in the reviewed release PR only when the migration is ready.

If one npm publish succeeds and the other fails, manually run the Release
workflow from `main` with `recover-coordinated-release: true` and set
`release-commit` to the exact 40-character SHA carrying both release tags.
Recovery verifies that commit is reachable from `main`, checks out that exact
commit, confirms both current release tags resolve to it, revalidates both versions against the coordination
marker, skips an exact version already present on npm, and publishes only the
missing version.

### Hotfixes

An urgent fix follows the same single-trunk path as any other change — there is
no separate hotfix or release branch to cherry-pick between:

1. Branch off the latest `main` (e.g. `fix/...`) and write the fix as a `fix:`
   commit so Release Please scores a **PATCH** bump.
2. Open a PR to `main`, get it reviewed and merged (squash) like normal — CI and
   branch protection still apply; don't bypass them.
3. If `.release-coordination.json` is present, update it to the patch versions
   for both packages.
4. Release Please updates the standing release PR with the patch bump. To ship
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
