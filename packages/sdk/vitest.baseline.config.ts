import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import { LIVE_EVENT_TIMEOUT_MS } from "./tests/integration/support/liveHarness";
import { FLAG_ON } from "./tests/baseline/toolkit/registry";
import { BASELINE_SCENARIOS } from "./vitest.config";

const CODEX_ACP_SMOKE = `${BASELINE_SCENARIOS}/adapters/codexAcpSmoke.test.ts`;

// Local runs read credentials from the repo's .env.test; variables already set (CI secrets) win.
const ENV_FILE = fileURLToPath(new URL("../../.env.test", import.meta.url));
if (existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
}

// A scenario chains setup and several live waits, each bounded by LIVE_EVENT_TIMEOUT_MS; the
// test outlasts them all, so a stalled wait fails naming what it waited for, not as a bare timeout.
const SCENARIO_TIMEOUT_MS = LIVE_EVENT_TIMEOUT_MS * 3;

// The live baseline (Tier 2): real platform, real LLMs. Tier 1 excludes these files.
export default defineConfig({
  test: {
    include: [`${BASELINE_SCENARIOS}/*.test.ts`],
    exclude: process.env.RUN_CODEX_ACP_E2E === FLAG_ON ? [] : [CODEX_ACP_SMOKE],
    testTimeout: SCENARIO_TIMEOUT_MS,
    hookTimeout: LIVE_EVENT_TIMEOUT_MS,
    reporters: ["default", "./tests/baseline/toolkit/scorecardReporter.ts"],
  },
});
