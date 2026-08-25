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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

describe("resolveConnectionConfig legacy env warnings (P-C6-1, table-driven)", () => {
  // account field -> BAND_* -> legacy THENVOI_* per field.
  const FIELDS = [
    { field: "apiKey" as const, band: "BAND_API_KEY", legacy: "THENVOI_API_KEY" },
    { field: "agentId" as const, band: "BAND_AGENT_ID", legacy: "THENVOI_AGENT_ID" },
    { field: "wsUrl" as const, band: "BAND_WS_URL", legacy: "THENVOI_WS_URL" },
    { field: "restUrl" as const, band: "BAND_REST_URL", legacy: "THENVOI_REST_URL" },
  ];
  const ALL = FIELDS.flatMap((f) => [f.band, f.legacy]);
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const v of ALL) { saved[v] = process.env[v]; delete process.env[v]; }
  });
  afterEach(() => {
    for (const v of ALL) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
    vi.restoreAllMocks();
  });

  async function fresh() {
    vi.resetModules();
    return (await import("../../src/config.js")).resolveConnectionConfig;
  }

  // Satisfy the two required fields (apiKey/agentId) via Band unless the target
  // field under test is itself one of them, so only the target uses the legacy var.
  function satisfyRequiredExcept(target: string): void {
    if (target !== "apiKey") process.env.BAND_API_KEY = "band-key";
    if (target !== "agentId") process.env.BAND_AGENT_ID = "band-agent";
  }

  for (const { field, band, legacy } of FIELDS) {
    it(`${field}: legacy ${legacy} is used, warns exactly once naming old + ${band}, never the value`, async () => {
      satisfyRequiredExcept(field);
      const secret = `legacy-${field}-VALUE`;
      process.env[legacy] = secret;
      const resolve = await fresh();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const conn = resolve({});
      expect(conn[field]).toBe(secret);
      const forThisVar = warn.mock.calls.filter((c) => String(c[0]).includes(legacy));
      expect(forThisVar).toHaveLength(1);
      expect(String(forThisVar[0][0])).toContain(band);
      for (const c of warn.mock.calls) expect(String(c[0])).not.toContain(secret);
      // repeated read dedupes (once per process)
      warn.mockClear();
      resolve({});
      expect(warn.mock.calls.filter((c) => String(c[0]).includes(legacy))).toHaveLength(0);
    });

    it(`${field}: BAND_ wins over legacy with zero warning`, async () => {
      satisfyRequiredExcept(field);
      process.env[band] = `band-${field}`;
      process.env[legacy] = `legacy-${field}`;
      const resolve = await fresh();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const conn = resolve({});
      expect(conn[field]).toBe(`band-${field}`);
      expect(warn).not.toHaveBeenCalled();
    });

    it(`${field}: account value wins over legacy with zero warning`, async () => {
      satisfyRequiredExcept(field);
      process.env[legacy] = `legacy-${field}`;
      const resolve = await fresh();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const conn = resolve({ [field]: `acct-${field}` } as Parameters<typeof resolve>[0]);
      expect(conn[field]).toBe(`acct-${field}`);
      expect(warn).not.toHaveBeenCalled();
    });
  }
});
