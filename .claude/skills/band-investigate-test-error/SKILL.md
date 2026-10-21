---
name: band-investigate-test-error
description: "Diagnose a failing or flaky TypeScript test with empirical product, test-assumption, toolkit, and model hypotheses. Use band-ci-triage first for an unidentified CI job and bug-hunting-via-example for runnable example failures."
---

# Investigate a Test Error

Read [workflow-runtime.md](../workflow-runtime.md) and the TypeScript test
conventions. Start with the exact failure, revision, command, environment and
selected tests. For CI, first establish the failing job and tested SHA using
`band-ci-triage`. Preserve existing authorization: diagnose only unless a fix
was requested; an already-authorized fix does not need another approval pause.

## Competing explanations

Inspect the test and actual callers before editing. Investigate independently
where useful and available, otherwise make separate passes:

- **Product:** real adapters/runtime/transport state and violated contracts.
- **Test assumption:** invalid expected ordering, an over-specific assertion,
  fake-clock interaction, or a fixture that cannot produce a real state.
- **Toolkit/environment:** provisioning, observer lifecycle, report integrity,
  stale dist, optional peers, process startup, or leaked resources.
- **Model/provider:** only for actual LLM calls; distinguish prompt ambiguity,
  provider errors and output variation from deterministic product defects.

Experiments that change source or dependencies use isolated worktrees. Do not
rewrite another agent's install, reset their files, or share generated build
outputs. Give any worker the raw failure, permitted side effects and one
hypothesis; require observed evidence rather than agreement with your guess.

## Establish the cause

Reproduce the smallest boundary that retains the failing interaction. Use
explicit gates and controlled clocks, real local peers where needed, and
existing flow helpers. Record the experiment, observation, and whether it
confirms or refutes each hypothesis. A temporary log or a failing regression
can reveal the exact state transition; reasoning alone remains a hypothesis.

For live tests, inspect provisioning, provider trace, reply observation,
delivery completion, history and cleanup separately. Read the baseline README
before interpreting those signals. Measure variation with a justified bounded
rerun only when it distinguishes model variance; do not label a failure flaky
because one retry passed. Never add sleeps, blanket retries, skips or weakened
assertions to disguise the failure.

## Synthesize and act

Rank supported causes, state ruled-out explanations, identify the owning layer,
and name the next discriminating experiment if still uncertain. Preserve
unverified claims as unknowns. If fixes are authorized, make a proportional
plan, repair the cause, prove the regression fails before and passes after,
and run applicable AGENTS checks. Otherwise return the diagnosis and proposed
fix. Report limitations and actual outcomes, not an assumed clean baseline.
