# Workflow mechanics

Concrete naming, commands, and templates for the upgrade-dependencies skill.
Read this alongside `SKILL.md`, which owns the decision logic.

## Branch naming

- Safe-updates branch (per package): `chore/deps-<pkg-short-name>-updates`
  e.g. `chore/deps-sdk-updates`, `chore/deps-openclaw-updates`.
- Isolated major-upgrade test/fix branch: `chore/deps-<pkg-short-name>-<dep-name>-<target-major>`
  e.g. `chore/deps-sdk-zod-4`. Sanitize `dep-name` for scoped packages
  (`@scope/name` → `scope-name`) so it's a valid branch/worktree path.

`<pkg-short-name>` is the last path segment (`sdk`, `openclaw`), not the full
npm package name.

## Isolated worktrees

Use a real git worktree per isolated test, not just a branch switch in the
main checkout — this repo's build/test commands run `pnpm -r`-style installs
that mutate `node_modules` and lockfile state, and you don't want two
in-flight upgrade attempts clobbering each other if you're working on more
than one at a time.

```bash
git worktree add ../band-sdk-typescript-<slug> -b <branch-name> main
cd ../band-sdk-typescript-<slug> && pnpm install
```

Clean up worktrees you no longer need with `git worktree remove`, but never
remove one that has a breaking-major fix still in flight — that's the base
for the step 5 subagent.

## Commit messages

Follow this repo's Conventional Commits convention (`CONTRIBUTING.md`):
Release Please parses these, and PR titles are validated in CI since PRs are
squash-merged.

- Safe updates: `chore(<pkg-short-name>): update dependencies`
  (`chore:` is hidden from the changelog, which is correct here — these
  aren't user-facing changes).
- A major bump that turned out safe, folded into the safe-updates branch:
  same commit, or a separate `chore(<pkg-short-name>): bump <dep> to v<major>`
  commit on that branch — either is fine, the PR is squash-merged anyway.
- A breaking-major fix: use `fix(<pkg-short-name>): update for <dep> vX` if
  your code changed to accommodate the new API, or
  `chore(<pkg-short-name>): bump <dep> to vX` if the version bump plus a
  trivial config change was all it took. Add a `BREAKING CHANGE:` footer only
  if this repo's own public API changed as a result — usually it won't have.

## PR conventions

- Base branch: `main`.
- Title: same as the lead commit message (CI validates PR titles as
  Conventional Commits).
- Body: list every dependency touched with old → new version. For a
  breaking-major PR, also link the Linear issue (`Fixes BAND-123` or similar
  per the team's convention — ask if unsure) and summarize what broke and
  what you changed to fix it.
- Open with `gh pr create --base main --head <branch> --title "..." --body "..."`.
  Add `--draft` for a breaking-major PR whose gate isn't green.

## Linear issue template

One issue per breaking dependency per package. Suggested structure for the
issue description:

```
## Dependency
<name>: <current version> → <target version>  (package: <workspace-name>)

## What broke
<failing command, e.g. `pnpm --filter @band-ai/sdk test`>

<relevant error output, trimmed to the useful part>

## Migration notes
<link to changelog/release notes/migration guide if found>

## Branch
chore/deps-<pkg-short-name>-<dep-name>-<target-major>
```

Title format: `Upgrade <dep-name> to vX in <workspace-name>`.

Link the resulting PR back to the issue (PR body reference, e.g.
`Fixes BAND-123`, plus a Linear comment with the PR URL) so status stays in
sync in both directions.

## Parallel subagent prompt shape (step 5)

Since each subagent starts with zero context, its prompt needs to be
self-contained. Include:

- Package path and workspace name.
- Dependency name, current version, target version.
- The exact failing command and its output from the isolation test.
- The Linear issue URL/identifier to reference in the PR and to comment on
  with progress.
- The branch/worktree it should work in (already created in step 3 — tell it
  to reuse that worktree, not create a new one).
- Explicit instruction to open a PR regardless of whether the fix succeeds,
  and to mark it draft + explain remaining breakage if it doesn't.

## Reusing the Linear team choice

If the user confirms a team/project to file these issues under, save it so
future runs don't have to ask again:

```json
{
  "teamId": "...",
  "teamName": "...",
  "projectId": null
}
```

Write this to `.claude/skills/upgrade-dependencies/linear-config.json`. This
file is local config, not a secret — fine to commit if the user wants it
shared with the rest of the team.
