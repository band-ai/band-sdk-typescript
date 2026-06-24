/**
 * Unit tests for the Band setup wizard's config-mutation logic.
 */

import { describe, it, expect } from "vitest";
import { setBandAccountConfig, ensureBandToolsAllowed, bandSetupWizard } from "../../src/setup-wizard.js";
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
