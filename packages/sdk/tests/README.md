# Test Layout

Tests are intentionally kept mostly flat.

Rationale:
- The SDK surface is broad but shallow; most test files map 1:1 to one adapter or one integration module.
- A flat list keeps adapter parity checks quick to scan during releases.
- Vitest startup/runtime is unaffected at this project size.

When this directory grows substantially beyond the current footprint, group by domain (`adapters/`, `runtime/`, `integrations/`) and keep `examples-*` tests together.

`tests/baseline/` is the live baseline suite: scenarios against the real Band
platform, fanned out across every adapter in its registry, with a scenario ×
adapter scorecard. See [`baseline/README.md`](baseline/README.md).
- `pnpm run test:baseline-live` runs the scenarios (`tests/baseline/scenarios/**`), which the
  default `vitest run` excludes. Scope a run with `-t <adapter|scenario>` or a scenario path, with
  no `--`. `BAND_E2E_INCLUDE_PENDING=1` also runs the adapters marked pending. Runs nightly and on
  manual dispatch via `.github/workflows/e2e.yml`.
- The toolkit's unit tests, including the `registry.test.ts` drift guard, run in the default
  `pnpm test`.

`tests/integration/` holds runnable scripts, excluded from the default `vitest run`
(none of its files end in `.test.ts`/`.spec.ts`, vitest's default include pattern):
- `pnpm build && npx tsx tests/integration/band-sdk-core-bundler.ts` — reads `dist/`, so build first; no secrets/network needed. Runs on every PR via `.github/workflows/ci.yml`'s `test` job.
- `support/liveHarness.ts` — shared live-platform plumbing (provisioning, reaping, env loading) for the baseline suite and `scripts/`.
