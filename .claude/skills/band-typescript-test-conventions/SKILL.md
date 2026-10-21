---
name: band-typescript-test-conventions
description: "Band TypeScript SDK test conventions and coverage assessment. Use when writing or reviewing tests, assessing meaningful coverage, or validating realistic complex flows."
---

# Test Conventions

## Coverage and realistic flows

Assess relevant existing tests whenever behavior changes, even if the diff
contains no tests. A green run, test count, or coverage percentage alone does
not establish correctness.

- Map user-visible scenarios and important invariants to meaningful assertions.
  Name the plausible regression each test catches; prioritize material gaps
  over numeric targets or implementation trivia.
- Exercise realistic sequences where relevant: follow-up turns, tool calls,
  cancellation, failure/recovery, reconnect, rehydration, concurrent rooms,
  permission decisions, and cleanup. Select reachable scenarios for the actual
  change rather than demanding every scenario for every feature.
- Drive real entry points and interacting components at the lowest boundary
  that preserves their behavior. Replace external services with realistic
  peers/fakes; do not mock away the interaction being proved. Build a missing
  fixture or peer when a material scenario needs one.
- Assert observable outcomes and consequential side effects. Mock calls alone
  rarely prove delivery, durable history, cancellation, or resource release.
  Extend useful existing tests rather than duplicating their setup.
- A defect regression should fail without the fix and pass with it. Report
  material gaps and blocked checks explicitly; never weaken assertions or
  disable a failing test to obtain green results.

## Layout and reusable boundaries

Read `packages/sdk/tests/README.md` and the affected package's Vitest config.
SDK tests use Vitest `describe`/`it` and are mostly flat `*.test.ts` files;
there is no one-class-per-file rule. Keep tests grouped by behavior and helpers
separate when sharing them makes the scenario clearer.

Reuse `packages/sdk/tests/testUtils.ts` and nearby support modules.
`tests/flows/support/bandPlatform.ts` (relative to the SDK package) drives the
real runtime, BandLink, Execution and AgentTools with the network replaced;
its `CallHolds` and `RecordLog` support realistic multi-component flows.
`FakeAgentTools` is useful at an adapter's platform seam, but is not proof of
platform transport behavior.

Live scenarios belong in `packages/sdk/tests/baseline/scenarios/`, selected by
`vitest.baseline.config.ts`; default Vitest excludes those scenarios but still
runs toolkit unit tests. Read the baseline README and `band-write-e2e-test`
when live coverage is needed. Plugin tests use their own configuration.

## Ordering, time, and cleanup

Use explicit deferred promises, gates, barriers, or observed state transitions.
Hold an operation at the boundary, assert while blocked, release it, and await
confirmed completion. Fixed sleeps and elapsed wall time are not evidence.

Use controlled clocks for expiry/deadline behavior. Keep real subprocess and
network readiness independent of the fake clock. Vitest's `vi.waitFor` advances
fake timers automatically when enabled: use explicit event gates when testing
ordering rather than letting polling drive the scenario. Real-time timeouts
may guard against hangs, not establish correctness.

Own every resource. Reuse `await using`/`AsyncDisposable` fixtures where
available, otherwise await cleanup in `finally`. Cover failed and cancelled
startup, restore mocks and timers, and confirm owned processes/listeners exit.
For state machines, table-driven event sequences or a small model can expose
repeated/cancelled/restarted flows without introducing a new test framework.

## Consumer and platform checks

Repository-wide content guards scan tracked guidance and documentation outside
package directories. Run the C6/C7 guard files selected by the packaging job in
`.github/workflows/ci.yml` for relevant prose changes; path-filtered SDK checks
alone do not establish that these invariants passed. The full SDK suite is not
required solely for prose changes.

Use host-native temporary paths and path utilities; do not skip an OS to hide
separator assumptions. Genuine unavailable boundaries may skip with a reason.
Check the actual workflow matrix before claiming cross-platform validation.

Public/package changes need relevant root/subpath import, optional-peer
isolation, ESM/CJS, and declaration consumer proofs. `tests/support/compileProof.ts`
uses the built package: run `pnpm build:sdk` from the root first when running
these tests directly. Root `pnpm test` and `pnpm typecheck` already build it.
Select further checks using `AGENTS.md` "Pre-Commit Checklist".
