# Test Layout

Tests are intentionally kept mostly flat.

Rationale:
- The SDK surface is broad but shallow; most test files map 1:1 to one adapter or one integration module.
- A flat list keeps adapter parity checks quick to scan during releases.
- Vitest startup/runtime is unaffected at this project size.

When this directory grows substantially beyond the current footprint, group by domain (`adapters/`, `runtime/`, `integrations/`) and keep `examples-*` tests together.

`tests/integration/` is intentionally excluded from the default `vitest run`.
Those files are operator-driven harnesses for real services and should be run explicitly when validating live adapters or bridge flows.

Current live harnesses include:
- `RUN_CODEX_ACP_E2E=1 npx tsx tests/integration/codex-acp-smoke.ts`
