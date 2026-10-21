---
name: upgrade-dependencies
description: Survey and upgrade outdated dependencies across this pnpm workspace, validate compatible batches and isolated major upgrades, and track blocked migrations in Linear. Use dependabot-triage for an existing bot PR queue; preview requests remain read-only.
---

# Upgrade Dependencies

Read [workflow-runtime.md](../workflow-runtime.md) and
[workflow mechanics](references/workflow.md). Discover packages from
`pnpm-workspace.yaml` and manifests; include the root tooling and affected
plugins as well as the SDK. Do not assume every package has the same scripts.

## Establish scope and baseline

An actual upgrade request authorizes implementation and the dependency PR/Linear
handoff described here. A preview, "what is outdated", or dry-run request only
surveys and reports; experiments must stay in isolated scratch worktrees and
must not publish. State the mode and requested package/version limits first.

Inspect current local/remote state. Work in owned worktrees at a recorded base;
never stash, reset, or switch a shared checkout. Keep node_modules and dist
outputs isolated. Resolve the Linear team from the existing `linear-config.json`
or available project context; ask only when necessary and never invent IDs.

Survey overlapping Dependabot PRs before proposing another update. Link existing
work and preserve its evidence. Do not close or replace another PR automatically;
require a validated replacement and authorization for supersession.

Install the baseline with `pnpm install --frozen-lockfile`, then run the relevant
build, lint, type and test checks. Save exit statuses and useful reports. For a
Vitest workspace, JSON output can be captured with its actual script, e.g.:

```bash
pnpm --filter @band-ai/sdk run test --reporter=json --outputFile=<absolute-report-path>
```

Build SDK output first when consumer tests need it. Use the selected package's
own command for non-Vitest checks. Do not apply a historical flake exemption.
Baseline and candidate must be comparable revisions/environments; inspect the
actual failure mechanism, not just matching test names.

The retained `scripts/diff_test_failures.mjs` is a limited legacy diagnostic:
it compares absolute file/test names and ignores collection/report structure
errors. It is unsuitable for cross-worktree equivalence or readiness decisions.
Use the original reports and command exit statuses; "no new failures" from that
helper is neither a passing gate nor proof that a failure is unrelated.

## Classify, then verify

From the repository root, the existing helper can survey a package:

```bash
node .claude/skills/upgrade-dependencies/scripts/classify_outdated.mjs <package-dir>
```

Its `safe` label only means its major-number comparison matched. Inspect actual
ranges, prereleases, zero-major updates, peer contracts and the lockfile before
choosing candidates. Complex/disjoint ranges and workspace aliases require
manual interpretation. Semver classification does not establish compatibility.
Record exact intended target versions from current release notes/metadata;
do not allow an advancing `latest` to change the experiment between runs.

Apply intended manifest/range changes with the affected package's pnpm workflow
and update `pnpm-lock.yaml` intentionally. Preserve public optional-peer ranges
unless changing supported compatibility is part of the plan. Inspect resolution
churn and confirm `pnpm install --frozen-lockfile` succeeds afterward.

1. Test compatible patch/minor candidates together in an owned package branch.
   If the batch fails, isolate the cause by controlled subsets; same-major
   regressions receive the same investigation as a breaking major.
2. Test each major independently from the verified baseline/batch, using its
   own worktree. Research migration guides and installed JS/types. Run relevant
   package checks and affected workspace consumers, not just that package's build.
3. Fold successful updates into the candidate branch, then validate the **final
   combined result**. Independent successes do not prove combined compatibility.
4. Attribute failing builds, type checks and tests against baseline evidence.
   Existing failures remain unresolved validation; do not label them harmless
   or call the candidate green. Use `band-investigate-test-error` when unclear.

## Blocked upgrades and fixes

For an actual upgrade run, file a Linear issue for each confirmed blocked
migration, recording dependency, package, exact version transition, failure
mechanism/evidence and next step. Group findings that share one cause.

Attempt in-scope migrations in their isolated worktrees. Independent work may
run in bounded parallel roles through the shared runtime guidance; one writer
owns each worktree and the coordinator alone publishes. No host-specific Agent
API or unlimited fan-out is assumed. Preserve unfinished branches/evidence.

Select validation using AGENTS: full workspace checks for broad dependency
changes, plus affected package formats, declarations, optional peers, plugins
and scoped live scenarios when necessary and authorized. Missing prerequisites
and nonzero exits are explicit blockers, not hidden exclusions.

## Publish and report

Create focused draft PRs for compatible batches and useful migration work,
including an unfinished migration only with its limitations clearly linked.
Follow the approved branch/title rules and Why/What/Scope description format.
Record version tables, checks and limitations in the Linear issue or evidence
attachment. Promote only after AGENTS author readiness passes and promotion is
authorized. No automatic merge or closing competing PRs.

Report every touched dependency by package: old → target, applied or blocked,
validated revision/checks, PR and Linear links, and remaining work. Distinguish
a partial migration from a tested compatible update.
