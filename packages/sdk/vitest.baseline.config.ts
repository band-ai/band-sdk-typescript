import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import { LIVE_EVENT_TIMEOUT_MS } from "./tests/integration/support/liveHarness";
import { BASELINE_SCENARIOS } from "./vitest.config";

// Local runs read credentials from the repo's .env.test; variables already set (CI secrets) win.
const ENV_FILE = fileURLToPath(new URL("../../.env.test", import.meta.url));
if (existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
}

// The live baseline (Tier 2): real platform, real LLMs. Tier 1 excludes these files.
export default defineConfig({
  test: {
    include: [`${BASELINE_SCENARIOS}/*.test.ts`],
    testTimeout: LIVE_EVENT_TIMEOUT_MS,
    hookTimeout: LIVE_EVENT_TIMEOUT_MS,
    reporters: ["default", "./tests/baseline/toolkit/scorecardReporter.ts"],
  },
});
