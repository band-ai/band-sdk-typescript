# Test Layout

Tests are intentionally kept mostly flat.

Rationale:
- The SDK surface is broad but shallow; most test files map 1:1 to one adapter or one integration module.
- A flat list keeps adapter parity checks quick to scan during releases.
- Vitest startup/runtime is unaffected at this project size.

When this directory grows substantially beyond the current footprint, group by domain (`adapters/`, `runtime/`, `integrations/`) and keep `examples-*` tests together.

`tests/integration/` is intentionally excluded from the default `vitest run`
(none of its files end in `.test.ts`/`.spec.ts`, vitest's default include pattern).
Some of these scripts are wired into CI, others are operator-driven and only
run by hand — check below before assuming either.

Current harnesses:
- `npx tsx tests/integration/smoke.ts`, `e2e.ts`, `two-codex-agents.ts` — operator-run only, not wired into any workflow; each needs live credentials from `agent_config.yaml`.
- `RUN_CODEX_ACP_E2E=1 npx tsx tests/integration/codex-acp-smoke.ts` — operator-run only, not wired into any workflow.
- `npx tsx tests/integration/band-sdk-core-bundler.ts` — no secrets/network needed; runs on every PR via `.github/workflows/ci.yml`'s `test` job.
- `BAND_API_KEY_USER=... npx tsx tests/integration/core-retry-participant-live.ts` — hits the real Band platform; nightly + manual dispatch only, via `.github/workflows/e2e.yml`.

Adding a new script here that should run in CI: wire it in explicitly (a new
step in `ci.yml` if it needs no secrets, or `e2e.yml` if it's a live test) and
add it to this list — nothing auto-discovers files dropped in this directory.
