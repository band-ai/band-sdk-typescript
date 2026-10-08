import { defineConfig } from "vitest/config";

import { LIVE_EVENT_TIMEOUT_MS, LIVE_TEST_TIMEOUT_MS, loadLocalEnvFile } from "./tests/integration/support/liveHarness";
import { FLAG_ON } from "./tests/baseline/toolkit/registry";
import { BASELINE_SCENARIOS } from "./vitest.config";

const CODEX_ACP_SMOKE = `${BASELINE_SCENARIOS}/adapters/codexAcpSmoke.test.ts`;

loadLocalEnvFile();

// The live baseline (Tier 2): real platform, real LLMs. Tier 1 excludes these files.
export default defineConfig({
  test: {
    include: [`${BASELINE_SCENARIOS}/*.test.ts`],
    exclude: process.env.RUN_CODEX_ACP_E2E === FLAG_ON ? [] : [CODEX_ACP_SMOKE],
    testTimeout: LIVE_TEST_TIMEOUT_MS,
    hookTimeout: LIVE_EVENT_TIMEOUT_MS,
    reporters: ["default", "./tests/baseline/toolkit/scorecardReporter.ts", ["./tests/support/liveRunReporter.ts", { lane: "sdk" }]],
  },
});
