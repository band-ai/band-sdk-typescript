# Dependency workflow mechanics

Read with [the upgrade workflow](../SKILL.md). These mechanics do not expand
the user's scope or permit changing another developer's work.

## Branches and isolation

Fetch the target base, inspect worktree/branch ownership, and create an owned
worktree for each independent experiment. Keep installs and build output local
to it. Ordinary branches may use `chore/deps-<package>-updates` or
`chore/deps-<package>-<dependency>-<major>`; sanitize scoped names for paths.
For Linear-linked branch creation use `band-linear-create-branch` and `git lb`.
Do not require a fabricated ticket for an ordinary dependency branch.

Use `pnpm install --frozen-lockfile` before changes to reproduce the baseline.
Update the lock intentionally only after the manifest change. Remove only this
run's clean, unused worktrees after all workers/processes have stopped; preserve
unfinished fixes and never delete a shared environment.

## Commits and PRs

Use Conventional Commits with types/scopes from `.github/workflows/pr-title.yml`;
if no scope fits, omit it. Do not infer allowed scopes from dependency names.
A dependency's major bump does not automatically mean this SDK has a breaking
API change; mark breaking changes only for actual consumer-facing breaks.

Create against the intended base (normally `main`) with `gh pr create --draft`.
Use only Why, What and Scope in the body, link the issue or evidence attachment,
and keep validation details there. Use a body file for multiline text. Before
promotion, perform the AGENTS readiness review against the final combined diff.
A draft may preserve a useful incomplete migration, but cannot be called ready.

Fetch and inspect the remote immediately before push. Integrate concurrent
commits without discarding them; never force-push another worker's changes.
Workers return diffs, commands and outcomes; the coordinator owns publication.

## Linear handoff

Resolve team/project from the existing configuration and available context.
For a new choice, ask the user; save a shared configuration change only when
requested. Do not print credentials or assume a tool name without discovery.

Record:

- Package, dependency and exact old → target versions/ranges.
- Root cause or unresolved hypothesis, failing command/revision and useful logs.
- Relevant release/migration sources and compatibility impact.
- Branch/PR, completed work, remaining work and a reproducible next experiment.

Use a concise issue title such as `Upgrade <dependency> to v<major> in <package>`.
Link the PR back without claiming it fixes the issue while essential work
remains. Keep evidence current rather than appending contradictory histories.
