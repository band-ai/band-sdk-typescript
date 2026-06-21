# Test Layout

Tests are intentionally kept mostly flat.

Rationale:
- The SDK surface is broad but shallow; most test files map 1:1 to one adapter or one integration module.
- A flat list keeps adapter parity checks quick to scan during releases.
- Vitest startup/runtime is unaffected at this project size.

When this directory grows substantially beyond the current footprint, group by domain (`adapters/`, `runtime/`, `integrations/`) and keep `examples-*` tests together.

`tests/integration/` holds operator-driven checks against real services. There are two kinds:

1. **`tsx` harnesses** (`*.ts`, e.g. `smoke.ts`, `e2e.ts`, `codex-acp-smoke.ts`). Because they are not
   named `*.test.ts`, the default `vitest run` never collects them; run them explicitly:
   - `RUN_CODEX_ACP_E2E=1 npx tsx tests/integration/codex-acp-smoke.ts`

2. **Gated vitest e2e tests** (`*.test.ts`). These ARE collected by `vitest run`, but each gates
   itself with `describe.skipIf(process.env.E2E_TESTS_ENABLED !== "true")`, so the default run reports
   them as **skipped** (no network, no credentials needed). They run only when the flag is set:
   - `pnpm test:e2e` — INT-853 LangGraph streaming adapter live e2e
     (`tests/integration/int-853-langgraph-streaming.test.ts`). Requires `.env.test` (repo root) with
     Anthropic keys (`ANTHROPIC_API_KEY`, `E2E_ANTHROPIC_MODEL`), the `tom`/`jery` agents
     (`TEST_AGENT_ID`/`BAND_API_KEY`, `TEST_AGENT_ID_2`/`BAND_API_KEY_2`), and platform URLs
     (`BAND_REST_URL`, `BAND_WS_URL`); plus the `@langchain/anthropic` dev dependency.
