---
name: band-run-e2e-live
description: "Run existing Band TypeScript baseline E2E scenarios against a live platform and real backends. Select the actual registry and report pass, fail, skip, and blocked outcomes; use band-write-e2e-test to add scenarios."
---

# Run Live E2E

Read [workflow-runtime.md](../workflow-runtime.md),
`packages/sdk/tests/baseline/README.md`, `vitest.baseline.config.ts` in that
package, and the selected entries in `tests/baseline/toolkit/adapters.ts`.
A live run provisions resources and may consume provider tokens; stay within
the requested run scope and reuse existing authorization.

## Preflight

Identify the requested scenario/adapters and exact revision. Inspect required
providers, CLIs, servers and capabilities in the registry, plus the relevant
`.github/workflows/e2e.yml` setup. Derive setup from the selected TypeScript job and registry.
Use an owned worktree/install when concurrent builds or dependency changes
would collide. Build SDK output when the selected checks consume it.

Use repository-root `.env.test` with the existing live harness. It loads via
`process.loadEnvFile`; pre-existing environment values win. Check intended
configuration without printing secret values or silently replacing it.
`BAND_API_KEY_USER` provisions agents/rooms; backend requirements vary by entry.
Never invent credential values or a second environment file.

The dedicated baseline config opts into live scenarios; default Vitest does
not run them. Pending adapters require `BAND_E2E_INCLUDE_PENDING=1` when the
user intends to include them. `bespokeOnly` entries and `RUN_CODEX_ACP_E2E`
have separate selection rules; inspect the registry/config instead of treating
these switches as interchangeable. Missing selected prerequisites are failures
or blockers, not successful exclusions.

## Run narrowly, collect complete evidence

From `packages/sdk`:

```bash
pnpm run test:baseline-live -t anthropic
pnpm run test:baseline-live tests/baseline/scenarios/<scenario>.test.ts
```

Replace the filter/path with the requested existing target. Do **not** insert
`--` before `-t`: this script forwards arguments directly to Vitest. Verify the
selected adapter/scenario IDs and collected counts rather than assuming the
filter matched. A zero-test run establishes nothing.

Capture the command, exit status, revision, scorecard/live-run report paths,
and pass/fail/skip counts with reasons. Preserve useful logs with secrets
redacted. Report actual report-completeness failures; an empty or missing
scorecard does not establish success. Await toolkit teardown and confirm
resources owned by the run are released; never delete another run's resources.

## Diagnose and finish

Separate provisioning/auth, backend startup, provider calls, reply capture,
delivery processing and cleanup failures. Use `band-investigate-test-error`
for unclear failures. Diagnose before rerunning; do not repeatedly spend tokens
until a stochastic run passes or call missing configuration a product defect.

Running tests does not authorize product fixes or publication. When fixes were
already requested, apply them at the owning layer and rerun affected checks.
Report the tested scope, outcomes, remaining gaps and blockers. Do not wait for
unrelated CI or claim unrun adapters passed.
