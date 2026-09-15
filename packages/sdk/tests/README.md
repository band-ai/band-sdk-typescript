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
- `smoke.ts`, `e2e.ts`, `two-codex-agents.ts`, and `codex-acp-smoke.ts` (that one needs `RUN_CODEX_ACP_E2E=1`) — operator-run only, not wired into any workflow; each needs live credentials from `agent_config.yaml`.
- `pnpm build && npx tsx tests/integration/band-sdk-core-bundler.ts` — reads `dist/`, so build first; no secrets/network needed. Runs on every PR via `.github/workflows/ci.yml`'s `test` job.
- `BAND_API_KEY_USER=... npx tsx tests/integration/core-retry-participant-live.ts` — hits the real Band platform; nightly + manual dispatch only, via `.github/workflows/e2e.yml`.
- `npx tsx tests/integration/omp-acp-live.ts` — requires `BAND_API_KEY_USER`, the OMP CLI, and working OMP provider credentials (any of the core provider env vars, e.g. `GEMINI_API_KEY`). Runs enabled nightly via `E2E_GOOGLE_API_KEY`. Reports a missing-prerequisite skip distinctly from an enabled live pass — once a provider credential is present, every later step (binary presence, the ACP handshake, each scenario) is a hard failure, not a skip.

Adding a new script here that should run in CI: wire it in explicitly (a new
step in `ci.yml` if it needs no secrets, or `e2e.yml` if it's a live test) and
add it to this list — nothing auto-discovers files dropped in this directory.
