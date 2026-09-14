---
name: upgrade-dependencies
description: Upgrade this repo's npm dependencies end to end — apply all safe patch/minor bumps and any major bumps that don't break the build/typecheck/tests, and for majors that DO break, file a Linear issue and attempt a real fix in parallel, opening a PR either way. Use this whenever the user asks to "update dependencies", "upgrade packages", "bump deps", "run dependency updates", check for outdated packages, or asks what's safe to upgrade in this pnpm workspace. Always finish with a summary of every dependency touched: what was updated directly, what major upgrades landed, and what Linear issues/PRs were opened for the ones that broke.
---

# Upgrade Dependencies

This repo (`band-sdk-typescript`) is a pnpm workspace with packages under
`packages/*` (currently `packages/sdk` → `@band-ai/sdk` and
`packages/openclaw` → `@band-ai/openclaw-channel-band`). This skill drives a
full dependency-upgrade pass, per package, ending in PRs you can review and
merge — not a silent auto-merge. Nothing gets pushed or filed until the plan
below says so.

Read `references/workflow.md` before starting — it has the exact git/gh/Linear
mechanics (branch names, PR conventions, worktree setup, Linear issue
template). This file is the decision logic; that file is the how-to.

## Mode: dry run vs real

Default to a **real run** (apply, commit, push, open PRs/issues) when the user
asks you to actually upgrade dependencies. Only do a dry run — classify and
test everything, but stop before committing/pushing/filing anything, and
report the plan instead — when the user explicitly asks to preview first
(e.g. "show me what would update", "dry run", "what's outdated") or when
you're validating a change to this skill itself.

Say up front in your first message which mode you're running in.

## Step 0 — sanity checks

- `git status` must be clean (or you must stash/note uncommitted work) before
  you start creating branches and worktrees off `main`.
- Confirm `gh auth status` succeeds — you need it to open PRs.
- Determine which Linear team/project new issues should go in. If
  `.claude/skills/upgrade-dependencies/linear-config.json` exists, use the
  team id there. Otherwise call `list_teams` (Linear MCP), show the user the
  options, ask which one to use, and offer to save the choice to that file
  for next time so you don't have to ask again.
- Discover the workspace packages by reading `pnpm-workspace.yaml` and
  globbing — don't hardcode the two packages above; new ones may appear.
- Dependabot also runs against this repo (`.github/dependabot.yml`, npm
  ecosystem, weekly). This skill upgrades independently rather than
  triaging Dependabot's queue, so before opening a PR for a dependency,
  `gh pr list --author "app/dependabot" --search "<dep-name>"` to check
  whether Dependabot already has an open PR for it — if so, close that PR
  (or note it in your PR body) rather than leaving two competing PRs for the
  same bump.

## Step 1 — classify outdated dependencies, per package

For each package directory, run:

```bash
node .claude/skills/upgrade-dependencies/scripts/classify_outdated.mjs <package-dir>
```

This shells out to `pnpm outdated --format json` and splits results into:
- **safe** — current and latest share the same major version (a patch/minor
  bump within the existing range).
- **major** — latest is a different major version, or the version isn't
  ordinary semver (treat those conservatively as "major" too, since you can't
  reason about compatibility from the number alone).

This is the classification the whole rest of the run hangs off of, so don't
skip straight to `pnpm update` without looking at this output first.

## Step 2 — apply the safe bucket per package

On a fresh branch off `main` for this package (see `references/workflow.md`
for the exact naming), bump every "safe" dependency to latest:

```bash
pnpm update --filter <workspace-name> --latest <dep1> <dep2> ...
```

Then run this package's full gate: `pnpm --filter <workspace-name> build`,
`typecheck`, and `test`. If it passes, this branch becomes the base for step 3
(major upgrades attach to it) and eventually the "safe updates" PR for this
package.

If the combined safe bucket fails the gate, don't give up on the whole batch
— bisect: back out deps one at a time (or binary-search if there are many)
until the gate passes, and move whichever dependency(ies) turned out to
actually break things into the "breaking" bucket from step 4, even though
`pnpm outdated` called them same-major. A same-major bump breaking the build
usually means the dependency doesn't follow semver strictly, or your code
relied on undocumented behavior — either way it deserves the same
Linear-issue-and-fix-attempt treatment as a real major bump, not silent
exclusion.

## Step 3 — test each major upgrade in isolation

For every entry in the "major" bucket, test it **on its own**, not bundled
with the others — two unrelated major bumps can each pass individually and
still conflict, and bundling them would hide which one actually caused a
failure.

For each one:

1. Create an isolated worktree/branch off the safe-updates branch from step 2
   (or off `main` if step 2 had nothing to apply for this package) — see
   `references/workflow.md`.
2. `pnpm update --filter <workspace-name> --latest <dep>` for just that one
   dependency.
3. Run the package's gate (build/typecheck/test).
4. **Passes** → this major upgrade is safe. Fold its change into the
   safe-updates branch from step 2 (cherry-pick or reapply the same
   `pnpm update` there) and discard the isolated worktree.
5. **Fails** → this is a breaking major. Keep the worktree/branch — don't
   discard it — and hand it to step 4. Don't try to fix it inline here; that
   happens in parallel in step 5 so a hard upgrade doesn't stall the rest of
   the run.

## Step 4 — file a Linear issue per breaking major

One issue per breaking dependency per package (not one giant issue for all of
them — they need to be worked in parallel and closed independently). Use the
template in `references/workflow.md`. Include: package, dependency, current →
target version, the failing command and its output/error, and a link to the
dependency's changelog/release notes if you can find one quickly (a broken
build is much faster to fix with the migration guide in hand).

## Step 5 — fix attempts, in parallel

Once all breaking majors across all packages are identified and have Linear
issues, spawn one subagent per breaking dependency, **all in the same
message** so they run concurrently — don't spawn them one at a time and wait.
Use `isolation: "worktree"` on the Agent call so each one works in its own
git worktree without stepping on the others.

Each subagent's job, spelled out in the prompt (it starts with zero context,
so give it the package name, dependency, version range, Linear issue
URL/identifier, and the exact failing output from step 3):

- Research what changed (changelog, migration guide, breaking-change notes).
- Update the code to work with the new major version.
- Re-run the package's build/typecheck/test gate.
- Commit, push the branch, and open a PR with `gh pr create` that references
  the Linear issue — **whether or not the fix fully succeeds**. If it
  couldn't get the gate green, open the PR as a draft, and write clearly in
  the PR description and a Linear comment what was tried and what's still
  broken, so a human can pick it up from a running start instead of from
  scratch.
- Report back: did the gate pass, and what's the PR URL.

See `references/workflow.md` for the exact commit/PR/Linear-linking format so
all of these come out consistent with each other.

## Step 6 — open the safe-updates PR(s)

One PR per package for everything that landed in the safe-updates branch
(original safe bucket + any major bumps that turned out not to break
anything). Title and body conventions are in `references/workflow.md`.

In dry-run mode, skip the actual `gh pr create` / Linear issue filing here and
in step 4/5 — just report what you *would* open.

## Step 7 — final report

Always end with a summary, grouped by package, covering every dependency you
touched:

- **Applied directly** (patch/minor + non-breaking majors): dependency,
  old → new version, and the safe-updates PR link.
- **Breaking majors**: dependency, old → target version, Linear issue link,
  PR link, and status (fix landed and gate is green / still broken, with a
  one-line reason).

This is the part the user actually reads — don't bury it, and don't make them
go dig through PR links to find out what happened to a specific dependency.
