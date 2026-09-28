import { defineConfig } from "vitest/config";

import { LIVE_EVENT_TIMEOUT_MS } from "./tests/integration/support/liveHarness";
import { BASELINE_SCENARIOS } from "./vitest.config";

// The live baseline (Tier 2): real platform, real LLMs. Tier 1 excludes these files.
export default defineConfig({
  test: {
    include: [`${BASELINE_SCENARIOS}/*.test.ts`],
    testTimeout: LIVE_EVENT_TIMEOUT_MS,
    hookTimeout: LIVE_EVENT_TIMEOUT_MS,
  },
});
