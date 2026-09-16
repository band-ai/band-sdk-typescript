# Test Layout

Tests are intentionally kept mostly flat.

Rationale:
- The SDK surface is broad but shallow; most test files map 1:1 to one adapter or one integration module.
- A flat list keeps adapter parity checks quick to scan during releases.
- Vitest startup/runtime is unaffected at this project size.

When this directory grows substantially beyond the current footprint, group by domain (`adapters/`, `runtime/`, `integrations/`) and keep `examples-*` tests together.

`tests/integration/` is intentionally excluded from the default `vitest run`
(none of its files end in `.test.ts`/`.spec.ts`, vitest's default include pattern).
Scripts named `*-live.ts` are discovered by `.github/workflows/e2e.yml` and
run nightly or through manual dispatch; the remaining scripts are operator-run.

Current harnesses:
- `smoke.ts`, `e2e.ts`, `two-codex-agents.ts`, and `codex-acp-smoke.ts` (that one needs `RUN_CODEX_ACP_E2E=1`) — operator-run only, not wired into any workflow; each needs live credentials from `agent_config.yaml`.
- `pnpm build && npx tsx tests/integration/band-sdk-core-bundler.ts` — reads `dist/`, so build first; no secrets/network needed. Runs on every PR via `.github/workflows/ci.yml`'s `test` job.
- `BAND_API_KEY_USER=... npx tsx tests/integration/core-retry-participant-live.ts` — hits the real Band platform; nightly + manual dispatch only, via `.github/workflows/e2e.yml`.
- `npx tsx tests/integration/copilot-acp-live.ts` — requires `BAND_API_KEY_USER`, the Copilot CLI, and either a Copilot GitHub token (`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN`) or BYOK provider configuration (`COPILOT_PROVIDER_BASE_URL`, `COPILOT_MODEL`, and any provider authentication it needs, such as `COPILOT_PROVIDER_API_KEY`). It reports a prerequisite skip when those are absent; that is distinct from an enabled live pass.

Adding a new `*-live.ts` script enrolls it in the live workflow automatically;
add it to this list and ensure it gates unavailable external prerequisites.
