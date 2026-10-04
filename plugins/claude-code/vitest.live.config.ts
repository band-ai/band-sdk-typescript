import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import { LIVE_EVENT_TIMEOUT_MS } from "../../packages/sdk/tests/integration/support/liveHarness";

// Local runs read credentials from the repo's .env.test; variables already set (CI secrets) win.
const ENV_FILE = fileURLToPath(new URL("../../.env.test", import.meta.url));
if (existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
}

// A test chains several live waits, each bounded by LIVE_EVENT_TIMEOUT_MS.
const LIVE_TEST_TIMEOUT_MS = LIVE_EVENT_TIMEOUT_MS * 3;

// The live lane: the built plugin against the real platform, no LLM.
export default defineConfig({
  test: {
    include: ["tests/live/**/*.test.ts"],
    testTimeout: LIVE_TEST_TIMEOUT_MS,
    hookTimeout: LIVE_EVENT_TIMEOUT_MS,
  },
});
