---
name: dependabot-triage
description: "Triage the existing Dependabot npm and GitHub Actions PR queue, validate exact proposed updates, and track blocked upgrades. Use upgrade-dependencies for a fresh outdated-package survey rather than bot PRs."
---

# Dependabot Triage

Read [workflow-runtime.md](../workflow-runtime.md), `.github/dependabot.yml`,
`docs/ci-cd-workflows.md`, and the relevant package manifests. A triage-only
request is read-only. Apply fixes, publish reviews/issues or replacement PRs
only within the user's request; merging requires explicit authorization.

## Survey the actual queue

Fetch open bot PRs with pagination. Record each number, head SHA, base,
dependencies and exact target versions/ranges, changed files, current checks,
review threads, age and ecosystem. Read the configured per-ecosystem/directory
limits and schedule; a full queue can delay new PRs. Do not increase the limit
or close a difficult upgrade just to make the queue look clear.

Classify from changed files and Dependabot configuration. `@scope/package`
contains a slash but is npm, not GitHub Actions. Keep workflow bumps separate
from manifest/lockfile updates. A red check is a lead requiring attribution,
not proof that the dependency is breaking.

## Reproduce and validate

Use owned isolated worktrees at fetched revisions. Preserve concurrent work
and install/build outputs. Apply the PR's actual manifest and lockfile intent;
do not silently substitute latest, widen a public peer range, or omit a
constraint change. Verify frozen-lockfile installation and inspect unrelated
resolution churn.

A combined npm batch can reveal compatibility interactions, but **a green
batch does not prove each standalone PR works**. Validate the exact standalone
head before approving it. If the requested outcome is a replacement batch PR,
validate the final combined branch and record which original PRs it supersedes.
Do not approve originals on the batch's evidence or close them before the
validated replacement and user authorization are established.

Use AGENTS validation for dependencies: build, lint, typecheck, affected/full
workspace tests, relevant ESM/CJS and declaration packaging proofs, optional
peers, and downstream plugins. For Actions changes, inspect the workflow and
run applicable workflow/release guards; never publish during a probe. Use
current primary release notes and installed source to assess compatibility.
Run scoped live coverage when needed and authorized; verify prerequisites
without printing secrets, and report blocked coverage honestly.

Compare failures to an unchanged baseline at a recorded revision. Matching
names do not establish the same cause, and existing failures do not count as
passing author validation. Diagnose/bisect in owned worktrees using the CI or
test-investigation skill; keep unexplained failures unresolved.

## Close the loop

When requested, publish a review only for its verified current head; state
exact scope and limitations. Create Linear follow-ups for excluded or blocked
upgrades under the resolved project/team, with version, cause, evidence and
next step. Preserve their existing PRs and links. Do not invent a team ID or
use GitHub Issues in place of Linear.

New replacement/fix PRs start as drafts with Why/What/Scope descriptions and
AGENTS author readiness evidence. Required approvals/checks and the current
merge queue still apply. If merging is authorized, re-read each head/base,
review state and checks after prior merges or bot rebases; do not force-push
bot branches, bypass protections, or reuse stale approvals.

Report per PR: validated revision, outcome, approved/fixed/deferred/unverified,
links, and remaining gates. Approval alone does not drain the open-PR queue.
