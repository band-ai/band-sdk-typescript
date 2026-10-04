/**
 * E2E Test Setup and Utilities
 *
 * Provides helpers for running tests against a real Band environment.
 * Requires BAND_API_KEY, BAND_AGENT_ID, and BAND_API_KEY_USER environment
 * variables (legacy THENVOI_* names are accepted as a fallback).
 */

/**
 * Configuration shape for E2E tests, matching BandLink constructor options.
 */
export interface E2EConfig {
  apiKey: string;
  agentId: string;
  userId: string;
  wsUrl: string;
  restUrl: string;
}

function envFirst(bandVar: string, legacyVar: string): string | undefined {
  return process.env[bandVar] ?? process.env[legacyVar];
}

/**
 * Get E2E test configuration from environment variables, Band-first with a
 * legacy `THENVOI_*` fallback. Throws if required variables are not set.
 */
export function getE2EConfig(): E2EConfig {
  const apiKey = envFirst("BAND_API_KEY", "THENVOI_API_KEY");
  const agentId = envFirst("BAND_AGENT_ID", "THENVOI_AGENT_ID");
  const userId = envFirst("BAND_API_KEY_USER", "THENVOI_API_KEY_USER");
  const wsUrl = envFirst("BAND_WS_URL", "THENVOI_WS_URL") ?? "wss://app.band.ai/api/v1/socket";
  const restUrl = envFirst("BAND_REST_URL", "THENVOI_REST_URL") ?? "https://app.band.ai";

  if (!apiKey) {
    throw new Error(
      "E2E tests require the BAND_API_KEY (legacy THENVOI_API_KEY) environment variable. " +
        "Set it to run tests against a real Band environment.",
    );
  }

  if (!agentId) {
    throw new Error(
      "E2E tests require the BAND_AGENT_ID (legacy THENVOI_AGENT_ID) environment variable. " +
        "Set it to run tests against a real Band environment.",
    );
  }

  if (!userId) {
    throw new Error(
      "E2E tests require the BAND_API_KEY_USER (legacy THENVOI_API_KEY_USER) environment variable. " +
        "Set it to run tests against a real Band environment.",
    );
  }

  return { apiKey, agentId, userId, wsUrl, restUrl };
}

/**
 * Check if E2E tests can run (env vars are set), Band-first with legacy fallback.
 */
export function canRunE2E(): boolean {
  return !!(
    envFirst("BAND_API_KEY", "THENVOI_API_KEY") &&
    envFirst("BAND_AGENT_ID", "THENVOI_AGENT_ID") &&
    envFirst("BAND_API_KEY_USER", "THENVOI_API_KEY_USER")
  );
}

/**
 * Skip message for when E2E env vars are not configured.
 */
export const E2E_SKIP_MESSAGE =
  "Skipping E2E test: BAND_API_KEY, BAND_AGENT_ID, and BAND_API_KEY_USER (or legacy THENVOI_*) not set";

/**
 * Helper to wait for a condition with timeout.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number = 10000,
  intervalMs: number = 100,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) {
      return;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timeout waiting for condition after ${timeoutMs}ms`);
}

/**
 * Sleep for a given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate a unique test identifier for isolation.
 */
export function testId(): string {
  return `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
