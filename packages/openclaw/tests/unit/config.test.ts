/**
 * Unit tests for the Band channel config module.
 *
 * Covers (architect Step-2 checklist):
 *  - resolveAccount precedence: plugins.entries vs channels, and the
 *    `openclaw-channel-band` id vs the `band` alias
 *  - resolveConnectionConfig env fallbacks: BAND_* primary, legacy THENVOI_*
 *    fallback (do NOT silently drop THENVOI_*), defaults, throw-on-missing
 *  - inspectAccount reports configured WITHOUT leaking the apiKey
 *  - validateConfig ok/err via an injected connectivity probe (no network)
 */

import { describe, it, expect, vi } from "vitest";
import {
  resolveAccount,
  listAccountIds,
  resolveConnectionConfig,
  inspectAccount,
  validateConfig,
  DEFAULT_WS_URL,
  DEFAULT_REST_URL,
} from "../../src/config.js";

describe("resolveAccount / listAccountIds", () => {
  it("resolves an account from channels['openclaw-channel-band']", () => {
    const cfg = {
      channels: { "openclaw-channel-band": { accounts: { default: { agentId: "a1" } } } },
    };
    expect(resolveAccount(cfg, "default")).toEqual({ agentId: "a1" });
    expect(listAccountIds(cfg)).toEqual(["default"]);
  });

  it("resolves an account from the 'band' channel alias", () => {
    const cfg = { channels: { band: { accounts: { work: { agentId: "a2" } } } } };
    expect(resolveAccount(cfg, "work")).toEqual({ agentId: "a2" });
    expect(listAccountIds(cfg)).toEqual(["work"]);
  });

  it("resolves an account from plugins.entries config", () => {
    const cfg = {
      plugins: { entries: { "openclaw-channel-band": { config: { accounts: { default: { agentId: "p1" } } } } } },
    };
    expect(resolveAccount(cfg, "default")).toEqual({ agentId: "p1" });
  });

  it("lets a channels entry override a plugins.entries entry for the same id", () => {
    const cfg = {
      plugins: { entries: { "openclaw-channel-band": { config: { accounts: { default: { agentId: "from-plugin" } } } } } },
      channels: { "openclaw-channel-band": { accounts: { default: { agentId: "from-channel" } } } },
    };
    expect(resolveAccount(cfg, "default")).toEqual({ agentId: "from-channel" });
  });

  it("defaults to { enabled: true } when the account is absent", () => {
    expect(resolveAccount({}, "default")).toEqual({ enabled: true });
  });

  it("defaults the accountId to 'default'", () => {
    const cfg = { channels: { band: { accounts: { default: { agentId: "d" } } } } };
    expect(resolveAccount(cfg)).toEqual({ agentId: "d" });
  });
});

describe("resolveConnectionConfig", () => {
  it("uses explicit account fields over env", () => {
    process.env.BAND_API_KEY = "env-key";
    const conn = resolveConnectionConfig({ apiKey: "acc-key", agentId: "acc-agent" });
    expect(conn).toEqual({
      apiKey: "acc-key",
      agentId: "acc-agent",
      wsUrl: DEFAULT_WS_URL,
      restUrl: DEFAULT_REST_URL,
    });
  });

  it("falls back to BAND_* env vars", () => {
    process.env.BAND_API_KEY = "band-key";
    process.env.BAND_AGENT_ID = "band-agent";
    process.env.BAND_WS_URL = "wss://ws.example";
    process.env.BAND_REST_URL = "https://rest.example";
    expect(resolveConnectionConfig({})).toEqual({
      apiKey: "band-key",
      agentId: "band-agent",
      wsUrl: "wss://ws.example",
      restUrl: "https://rest.example",
    });
  });

  it("falls back to legacy THENVOI_* when BAND_* is absent (back-compat)", () => {
    process.env.THENVOI_API_KEY = "legacy-key";
    process.env.THENVOI_AGENT_ID = "legacy-agent";
    expect(resolveConnectionConfig({})).toMatchObject({
      apiKey: "legacy-key",
      agentId: "legacy-agent",
    });
  });

  it("prefers BAND_* over legacy THENVOI_*", () => {
    process.env.BAND_API_KEY = "band-key";
    process.env.THENVOI_API_KEY = "legacy-key";
    process.env.BAND_AGENT_ID = "band-agent";
    expect(resolveConnectionConfig({}).apiKey).toBe("band-key");
  });

  it("applies default ws/rest URLs", () => {
    const conn = resolveConnectionConfig({ apiKey: "k", agentId: "a" });
    expect(conn.wsUrl).toBe(DEFAULT_WS_URL);
    expect(conn.restUrl).toBe(DEFAULT_REST_URL);
  });

  it("throws when apiKey is missing", () => {
    expect(() => resolveConnectionConfig({ agentId: "a" })).toThrow(/api key/i);
  });

  it("throws when agentId is missing", () => {
    expect(() => resolveConnectionConfig({ apiKey: "k" })).toThrow(/agent id/i);
  });
});

describe("inspectAccount", () => {
  it("reports configured and never leaks the apiKey", () => {
    const cfg = { channels: { band: { accounts: { default: { apiKey: "tv_secret", agentId: "a" } } } } };
    const info = inspectAccount(cfg, "default");
    expect(info.configured).toBe(true);
    expect(info.agentId).toBe("a");
    expect(info.hasApiKey).toBe(true);
    // the secret must not appear anywhere in the inspection output
    expect(JSON.stringify(info)).not.toContain("tv_secret");
  });

  it("reports not configured when creds are missing", () => {
    const info = inspectAccount({}, "default");
    expect(info.configured).toBe(false);
    expect(info.hasApiKey).toBe(false);
  });
});

describe("validateConfig", () => {
  it("returns valid:true when the connectivity probe resolves", async () => {
    const probe = vi.fn().mockResolvedValue(undefined);
    const res = await validateConfig({ apiKey: "k", agentId: "a" }, probe);
    expect(res).toEqual({ valid: true });
    expect(probe).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "k", agentId: "a" }),
    );
  });

  it("returns valid:false with the error message when the probe rejects", async () => {
    const probe = vi.fn().mockRejectedValue(new Error("401 unauthorized"));
    const res = await validateConfig({ apiKey: "k", agentId: "a" }, probe);
    expect(res.valid).toBe(false);
    expect(res.errors?.[0]).toMatch(/401 unauthorized/);
  });

  it("returns valid:false without calling the probe when creds are missing", async () => {
    const probe = vi.fn();
    const res = await validateConfig({ agentId: "a" }, probe);
    expect(res.valid).toBe(false);
    expect(res.errors?.[0]).toMatch(/api key/i);
    expect(probe).not.toHaveBeenCalled();
  });
});
