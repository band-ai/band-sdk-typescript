/**
 * P-C6-3: E2E credential resolution is Band-first with a legacy THENVOI_*
 * per-field fallback, and eligibility (`canRunE2E`) agrees with config
 * (`getE2EConfig`) on the exact same resolution.
 *
 * These are pure env-resolution unit tests — no network, no real E2E run —
 * so the Band-first contract is exercised even when credentials are absent.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { getE2EConfig, canRunE2E, E2E_SKIP_MESSAGE } from "../e2e/setup.js";

const VARS = [
  "BAND_API_KEY",
  "BAND_AGENT_ID",
  "BAND_API_KEY_USER",
  "BAND_WS_URL",
  "BAND_REST_URL",
  "THENVOI_API_KEY",
  "THENVOI_AGENT_ID",
  "THENVOI_API_KEY_USER",
  "THENVOI_WS_URL",
  "THENVOI_REST_URL",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const v of VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
});

afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

describe("E2E config resolution (P-C6-3)", () => {
  it("resolves from BAND_* only", () => {
    process.env.BAND_API_KEY = "band-key";
    process.env.BAND_AGENT_ID = "band-agent";
    process.env.BAND_API_KEY_USER = "band-user";
    process.env.BAND_WS_URL = "wss://band.ws";
    process.env.BAND_REST_URL = "https://band.rest";
    expect(canRunE2E()).toBe(true);
    expect(getE2EConfig()).toEqual({
      apiKey: "band-key",
      agentId: "band-agent",
      userId: "band-user",
      wsUrl: "wss://band.ws",
      restUrl: "https://band.rest",
    });
  });

  it("falls back to legacy THENVOI_* only", () => {
    process.env.THENVOI_API_KEY = "legacy-key";
    process.env.THENVOI_AGENT_ID = "legacy-agent";
    process.env.THENVOI_API_KEY_USER = "legacy-user";
    expect(canRunE2E()).toBe(true);
    expect(getE2EConfig()).toMatchObject({
      apiKey: "legacy-key",
      agentId: "legacy-agent",
      userId: "legacy-user",
      // URL defaults still land on Band
      wsUrl: "wss://app.band.ai/api/v1/socket",
      restUrl: "https://app.band.ai",
    });
  });

  it("resolves each field independently (mixed Band/legacy)", () => {
    process.env.BAND_API_KEY = "band-key";
    process.env.THENVOI_AGENT_ID = "legacy-agent";
    process.env.BAND_API_KEY_USER = "band-user";
    process.env.THENVOI_WS_URL = "wss://legacy.ws";
    expect(getE2EConfig()).toMatchObject({
      apiKey: "band-key",
      agentId: "legacy-agent",
      userId: "band-user",
      wsUrl: "wss://legacy.ws",
      restUrl: "https://app.band.ai",
    });
  });

  it("prefers BAND_API_KEY_USER over legacy THENVOI_API_KEY_USER", () => {
    process.env.BAND_API_KEY = "band-key";
    process.env.BAND_AGENT_ID = "band-agent";
    process.env.BAND_API_KEY_USER = "band-user";
    process.env.THENVOI_API_KEY_USER = "legacy-user";
    expect(getE2EConfig().userId).toBe("band-user");
  });

  it("prefers BAND_* over legacy for every field when both are set", () => {
    for (const f of ["API_KEY", "AGENT_ID", "API_KEY_USER", "WS_URL", "REST_URL"]) {
      process.env[`BAND_${f}`] = `band-${f}`;
      process.env[`THENVOI_${f}`] = `legacy-${f}`;
    }
    expect(getE2EConfig()).toEqual({
      apiKey: "band-API_KEY",
      agentId: "band-AGENT_ID",
      userId: "band-API_KEY_USER",
      wsUrl: "band-WS_URL",
      restUrl: "band-REST_URL",
    });
  });

  it("applies Band URL defaults when WS/REST are unset", () => {
    process.env.BAND_API_KEY = "k";
    process.env.BAND_AGENT_ID = "a";
    process.env.BAND_API_KEY_USER = "u";
    const cfg = getE2EConfig();
    expect(cfg.wsUrl).toBe("wss://app.band.ai/api/v1/socket");
    expect(cfg.restUrl).toBe("https://app.band.ai");
  });

  it("throws naming the BAND_ variable for each missing required field", () => {
    process.env.BAND_AGENT_ID = "a";
    process.env.BAND_API_KEY_USER = "u";
    expect(() => getE2EConfig()).toThrow(/BAND_API_KEY\b/);

    delete process.env.BAND_AGENT_ID;
    process.env.BAND_API_KEY = "k";
    process.env.BAND_AGENT_ID = undefined as unknown as string;
    delete process.env.BAND_AGENT_ID;
    expect(() => getE2EConfig()).toThrow(/BAND_AGENT_ID/);

    process.env.BAND_AGENT_ID = "a";
    delete process.env.BAND_API_KEY_USER;
    expect(() => getE2EConfig()).toThrow(/BAND_API_KEY_USER/);
  });

  it("reports canRunE2E=false when any required field is missing", () => {
    process.env.BAND_API_KEY = "k";
    process.env.BAND_AGENT_ID = "a";
    // no user
    expect(canRunE2E()).toBe(false);
  });

  it("eligibility agrees with config: BAND-only satisfies both (no legacy divergence)", () => {
    process.env.BAND_API_KEY = "k";
    process.env.BAND_AGENT_ID = "a";
    process.env.BAND_API_KEY_USER = "u";
    // Red-check: eligibility must NOT be Band-first while config reads legacy.
    expect(canRunE2E()).toBe(true);
    expect(() => getE2EConfig()).not.toThrow();
    expect(getE2EConfig().apiKey).toBe("k");
  });

  it("eligibility and config agree when nothing is set", () => {
    expect(canRunE2E()).toBe(false);
    expect(() => getE2EConfig()).toThrow();
  });

  it("skip message names Band vars with a legacy note", () => {
    expect(E2E_SKIP_MESSAGE).toContain("BAND_API_KEY_USER");
    expect(E2E_SKIP_MESSAGE).toMatch(/legacy THENVOI_/);
  });
});
