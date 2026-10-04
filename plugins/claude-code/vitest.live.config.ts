import { defineConfig } from "vitest/config";

import {
  LIVE_EVENT_TIMEOUT_MS,
  LIVE_TEST_TIMEOUT_MS,
  loadLocalEnvFile,
} from "../../packages/sdk/tests/integration/support/liveHarness";

loadLocalEnvFile();

// The live lane: the built plugin against the real platform, no LLM.
export default defineConfig({
  test: {
    include: ["tests/live/**/*.test.ts"],
    testTimeout: LIVE_TEST_TIMEOUT_MS,
    hookTimeout: LIVE_EVENT_TIMEOUT_MS,
  },
});
