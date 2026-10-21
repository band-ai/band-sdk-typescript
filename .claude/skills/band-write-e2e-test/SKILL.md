---
name: band-write-e2e-test
description: "Write or extend TypeScript live baseline scenarios using the existing adapter registry, provisioning, observers, and assertions. Use band-run-e2e-live to run existing scenarios."
---

# Write an E2E Test

Read [workflow-runtime.md](../workflow-runtime.md),
`packages/sdk/tests/baseline/README.md`, and the relevant toolkit/scenario
source. Apply `band-typescript-test-conventions`. Do not rebuild provisioning,
observation, reporting, or cleanup when the toolkit already owns it.

## Plan the proof

Establish the user-visible outcome and meaningful failure/recovery cases.
Map existing scenarios before adding another. Use unit or realistic local flow
tests when they prove the behavior; live tests are for real integration seams.
Write the given/when/then scenario, required adapters/capabilities, expected
observations, and resource lifecycle before implementation. Check that a
plausible defect would fail the assertions and that the setup is reusable.

## Use the TS baseline contract

- Put live scenarios under `packages/sdk/tests/baseline/scenarios/`; inspect
  `scenarios/samples/` for current patterns.
- Use `scenarioId(CATEGORY.*, name)` and `perAdapter` for shared behavior.
  Use `withAdapters` for real multi-agent/shared-room scenarios. Select by
  supported capabilities and the registry rather than duplicating adapter IDs.
- Read `toolkit/adapters.ts` for builders, requirements, pending and bespoke
  entries. New capability requirements need evidence from actual adapters.
- Use toolkit provisioning with `await using`/`AsyncDisposable` and owned
  resource stacks. Ensure cleanup on assertion, cancellation, and startup failure.
- Open observers before sending triggers. A room reply and delivery processing
  are different, unordered signals: `observeRoom(room).untilReply(agent)` does
  not establish `observeAgent(agent, room).untilProcessed(sent)`. Await the
  latter and assert its returned status before reading durable history:
  `assertDeliveryStatus(await observeAgent(agent, room).untilProcessed(sent), DELIVERY_STATUS.processed)`.
  `untilProcessed` can return a stalled/non-processed state on timeout; awaiting
  it alone is not a successful barrier. Reuse `scenarios/samples/turns.ts`
  `takeTurn` when it fits the scenario.
- Use explicit marker/content and structural assertions appropriate to the
  scenario. Do not require exact stochastic transcripts or invent an LLM
  judge API. Prove cross-agent isolation and follow-up behavior when relevant.
- Follow existing selection/skip policy. Never turn a missing requirement for
  a selected adapter into an unnoticed pass or weaken reporting completeness.

## Validate and deliver

Review scenario placement, reuse, observer ordering, assertions, cleanup, and
scorecard identity. Run affected toolkit tests when helpers change; run the
specific live scenario with `band-run-e2e-live` when authorized and available.
Do not hide a failed run with retries. Use `band-investigate-test-error` for an
unclear failure, keeping product, test, toolkit and model hypotheses separate.

Report the scenario-to-assertion coverage and actual pass/fail/skip outcomes.
Keep a PR draft if essential author validation remains blocked, per AGENTS.
