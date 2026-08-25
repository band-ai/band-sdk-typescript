/**
 * Unit tests for the Band setup wizard's config-mutation logic.
 */

import { describe, it, expect, afterEach } from "vitest";
import { setBandAccountConfig, ensureBandToolsAllowed, bandSetupWizard, applyBandAccountConfig } from "../../src/setup-wizard.js";
import { BAND_CHANNEL_ID } from "../../src/config.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asCfg = (o: unknown) => o as any;
const band = (cfg: unknown) => asCfg(cfg).channels?.[BAND_CHANNEL_ID];
const tools = (cfg: unknown) => asCfg(cfg).tools;

describe("setBandAccountConfig", () => {
  it("writes a nested account, enables the channel, and is immutable", () => {
    const cfg = {};
    const next = setBandAccountConfig(asCfg(cfg), "default", { apiKey: "tv_x" });
    expect(band(next).enabled).toBe(true);
    expect(band(next).accounts.default).toEqual({ apiKey: "tv_x" });
    expect(asCfg(cfg).channels).toBeUndefined(); // original not mutated
  });

  it("merges into an existing account without dropping prior fields", () => {
    let cfg = setBandAccountConfig(asCfg({}), "default", { apiKey: "tv_x" });
    cfg = setBandAccountConfig(cfg, "default", { agentId: "a-1" });
    expect(band(cfg).accounts.default).toEqual({ apiKey: "tv_x", agentId: "a-1" });
  });

  it("keeps separate accounts isolated", () => {
    let cfg = setBandAccountConfig(asCfg({}), "default", { apiKey: "k1" });
    cfg = setBandAccountConfig(cfg, "work", { apiKey: "k2" });
    expect(band(cfg).accounts.default.apiKey).toBe("k1");
    expect(band(cfg).accounts.work.apiKey).toBe("k2");
  });
});

describe("ensureBandToolsAllowed", () => {
  it("adds the band + message tools to alsoAllow under a profile", () => {
    const cfg = ensureBandToolsAllowed(asCfg({ tools: { profile: "coding" } }));
    expect(tools(cfg).alsoAllow).toEqual([BAND_CHANNEL_ID, "message"]);
  });

  it("creates tools.alsoAllow when no tools config exists", () => {
    const cfg = ensureBandToolsAllowed(asCfg({}));
    expect(tools(cfg).alsoAllow).toEqual([BAND_CHANNEL_ID, "message"]);
  });

  it("merges into allow (not alsoAllow) when the operator uses an explicit allowlist", () => {
    const cfg = ensureBandToolsAllowed(asCfg({ tools: { allow: ["read", BAND_CHANNEL_ID] } }));
    // schema forbids allow + alsoAllow together, so merge into allow and dedup
    expect(tools(cfg).allow).toEqual(["read", BAND_CHANNEL_ID, "message"]);
    expect(tools(cfg).alsoAllow).toBeUndefined();
  });

  it("leaves the 'full' profile untouched (everything already exposed)", () => {
    const cfg = ensureBandToolsAllowed(asCfg({ tools: { profile: "full" } }));
    expect(tools(cfg).alsoAllow).toBeUndefined();
  });

  it("is idempotent (no duplicate entries)", () => {
    let cfg = ensureBandToolsAllowed(asCfg({ tools: { profile: "coding" } }));
    cfg = ensureBandToolsAllowed(cfg);
    expect(tools(cfg).alsoAllow).toEqual([BAND_CHANNEL_ID, "message"]);
  });

  it("setBandAccountConfig also ensures the tools are allowlisted", () => {
    const cfg = setBandAccountConfig(asCfg({ tools: { profile: "coding" } }), "default", { apiKey: "tv_x" });
    expect(tools(cfg).alsoAllow).toEqual([BAND_CHANNEL_ID, "message"]);
  });
});

describe("bandSetupWizard", () => {
  it("targets the band channel and prompts API key (credential) + agent id (text)", () => {
    expect(bandSetupWizard.channel).toBe(BAND_CHANNEL_ID);
    expect(bandSetupWizard.credentials.map((c) => c.inputKey)).toContain("token");
    const textKeys = (bandSetupWizard.textInputs ?? []).map((t) => t.inputKey);
    expect(textKeys).toEqual(["userId", "httpUrl", "baseUrl"]);
  });

  it("resolveConfigured is true only with both apiKey and agentId", () => {
    const empty = asCfg({});
    expect(bandSetupWizard.status.resolveConfigured({ cfg: empty, accountId: "default" })).toBe(false);

    let cfg = setBandAccountConfig(asCfg({}), "default", { apiKey: "tv_x" });
    expect(bandSetupWizard.status.resolveConfigured({ cfg, accountId: "default" })).toBe(false);

    cfg = setBandAccountConfig(cfg, "default", { agentId: "a-1" });
    expect(bandSetupWizard.status.resolveConfigured({ cfg, accountId: "default" })).toBe(true);
  });

  it("the agent-id text input writes agentId via applySet", () => {
    const input = (bandSetupWizard.textInputs ?? []).find((t) => t.inputKey === "userId")!;
    const cfg = input.applySet!({ cfg: asCfg({}), accountId: "default", value: " a-99 " });
    expect(band(cfg).accounts.default.agentId).toBe("a-99");
  });

  it("optional URL inputs are no-ops when left blank", () => {
    const ws = (bandSetupWizard.textInputs ?? []).find((t) => t.inputKey === "httpUrl")!;
    const cfg = ws.applySet!({ cfg: asCfg({}), accountId: "default", value: "  " });
    expect(band(cfg)).toBeUndefined(); // blank -> unchanged config
  });

  it("disable turns the channel off", () => {
    const enabled = setBandAccountConfig(asCfg({}), "default", { apiKey: "k" });
    const disabled = bandSetupWizard.disable!(enabled);
    expect(band(disabled).enabled).toBe(false);
  });
});

describe("applyBandAccountConfig (non-interactive `channels add --flags` mapping)", () => {
  it("maps token/userId/baseUrl onto apiKey/agentId/restUrl", () => {
    const cfg = applyBandAccountConfig(asCfg({}), "default", {
      token: "band_a_x",
      userId: "agent-1",
      baseUrl: "https://custom.example",
    });
    expect(band(cfg).accounts.default).toMatchObject({
      apiKey: "band_a_x",
      agentId: "agent-1",
      restUrl: "https://custom.example",
    });
  });

  it("prefers httpUrl over url for wsUrl when both are given", () => {
    const cfg = applyBandAccountConfig(asCfg({}), "default", {
      httpUrl: "wss://from-http-url",
      url: "wss://from-url",
    });
    expect(band(cfg).accounts.default.wsUrl).toBe("wss://from-http-url");
  });

  it("falls back to url for wsUrl when httpUrl is absent", () => {
    const cfg = applyBandAccountConfig(asCfg({}), "default", { url: "wss://from-url" });
    expect(band(cfg).accounts.default.wsUrl).toBe("wss://from-url");
  });

  it("writes no fields (but still enables the channel) when input is empty", () => {
    const cfg = applyBandAccountConfig(asCfg({}), "default", {});
    expect(band(cfg).accounts.default).toEqual({});
    expect(band(cfg).enabled).toBe(true);
  });
});

describe("bandSetupWizard credentials[0] (token) allowEnv + inspect", () => {
  const originalEnv = process.env.BAND_API_KEY;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.BAND_API_KEY;
    else process.env.BAND_API_KEY = originalEnv;
  });

  it("allows the env fallback only for the default account", () => {
    const token = bandSetupWizard.credentials[0];
    expect(token.allowEnv!({ cfg: asCfg({}), accountId: "default" })).toBe(true);
    expect(token.allowEnv!({ cfg: asCfg({}), accountId: "secondary" })).toBe(false);
  });

  it("inspect resolves the configured value, falling back to BAND_API_KEY for the default account", () => {
    process.env.BAND_API_KEY = "env-key";
    const token = bandSetupWizard.credentials[0];

    const unconfigured = token.inspect!({ cfg: asCfg({}), accountId: "default" });
    expect(unconfigured).toMatchObject({ hasConfiguredValue: false, resolvedValue: "env-key", envValue: "env-key" });

    const withStoredKey = setBandAccountConfig(asCfg({}), "default", { apiKey: "stored-key" });
    const configured = token.inspect!({ cfg: withStoredKey, accountId: "default" });
    expect(configured).toMatchObject({ hasConfiguredValue: true, resolvedValue: "stored-key" });

    const nonDefault = token.inspect!({ cfg: asCfg({}), accountId: "secondary" });
    expect(nonDefault).toMatchObject({ hasConfiguredValue: false, resolvedValue: undefined, envValue: undefined });
  });
});

describe("bandSetupWizard textInputs currentValue + truthy applySet", () => {
  it("httpUrl/baseUrl currentValue read back the stored wsUrl/restUrl", () => {
    const httpUrl = (bandSetupWizard.textInputs ?? []).find((t) => t.inputKey === "httpUrl")!;
    const baseUrl = (bandSetupWizard.textInputs ?? []).find((t) => t.inputKey === "baseUrl")!;
    const empty = asCfg({});
    expect(httpUrl.currentValue!({ cfg: empty, accountId: "default" })).toBeUndefined();
    expect(baseUrl.currentValue!({ cfg: empty, accountId: "default" })).toBeUndefined();

    const cfg = setBandAccountConfig(empty, "default", { wsUrl: "wss://stored", restUrl: "https://stored" });
    expect(httpUrl.currentValue!({ cfg, accountId: "default" })).toBe("wss://stored");
    expect(baseUrl.currentValue!({ cfg, accountId: "default" })).toBe("https://stored");
  });

  it("userId currentValue reads back the stored agentId", () => {
    const userId = (bandSetupWizard.textInputs ?? []).find((t) => t.inputKey === "userId")!;
    expect(userId.currentValue!({ cfg: asCfg({}), accountId: "default" })).toBeUndefined();
    const cfg = setBandAccountConfig(asCfg({}), "default", { agentId: "a-7" });
    expect(userId.currentValue!({ cfg, accountId: "default" })).toBe("a-7");
  });

  it("userId validate requires a non-blank value", () => {
    const userId = (bandSetupWizard.textInputs ?? []).find((t) => t.inputKey === "userId")!;
    expect(userId.validate!({ value: "  " })).toBe("Agent id is required");
    expect(userId.validate!({ value: "a-1" })).toBeUndefined();
  });

  it("httpUrl/baseUrl applySet write the trimmed value when non-blank", () => {
    const httpUrl = (bandSetupWizard.textInputs ?? []).find((t) => t.inputKey === "httpUrl")!;
    const baseUrl = (bandSetupWizard.textInputs ?? []).find((t) => t.inputKey === "baseUrl")!;

    const withWs = httpUrl.applySet!({ cfg: asCfg({}), accountId: "default", value: "  wss://new  " });
    expect(band(withWs).accounts.default.wsUrl).toBe("wss://new");

    const withRest = baseUrl.applySet!({ cfg: asCfg({}), accountId: "default", value: "  https://new  " });
    expect(band(withRest).accounts.default.restUrl).toBe("https://new");
  });
});
