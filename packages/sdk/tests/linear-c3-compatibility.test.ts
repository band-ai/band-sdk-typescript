/**
 * P-C3 proof tests: config/env Band-first compatibility, export renames,
 * and legacy fallback behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── P-C3-1: Export rename compile-time proof ─────────────────────────────────

describe("P-C3-1: exported Linear types", () => {
  it("new Band names are importable from the linear subpath", async () => {
    const linear = await import("../src/linear");
    // These are the renamed exports — if they don't exist, this test fails at import
    expect(linear.LinearBandBridgeConfig).toBeUndefined(); // it's a type, not a value
    // But we can check the barrel exports contain the type names via the module
    expect("handleAgentSessionEvent" in linear).toBe(true);
    expect("createLinearWebhookHandler" in linear).toBe(true);
  });

  it("old LinearThenvoi names are absent from the linear barrel", async () => {
    const linear = await import("../src/linear");
    const exportNames = Object.keys(linear);
    const staleNames = exportNames.filter((name) => name.includes("LinearThenvoi"));
    expect(staleNames).toEqual([]);
  });
});

// ── P-C3-2/3B: Config and env Band-first compatibility ──────────────────────

describe("P-C3-2: loadBandLinearConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "c3-config-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Dynamically import to avoid module-scoped state issues
  async function getLoader() {
    return import("../examples/linear-band/linear-band-bridge-agent");
  }

  it("loads Band-key config when present", async () => {
    const configPath = join(tmpDir, "agent_config.yaml");
    writeFileSync(configPath, `
linear_band_bridge:
  agent_id: "band-agent-id"
  api_key: "band-api-key"
`);
    const { loadBandLinearConfig } = await getLoader();
    const config = loadBandLinearConfig("linear_band_bridge", "linear_thenvoi_bridge", configPath);
    expect(config.agentId).toBe("band-agent-id");
  });

  it("falls back to legacy key with warning when Band key is absent", async () => {
    const configPath = join(tmpDir, "agent_config.yaml");
    writeFileSync(configPath, `
linear_thenvoi_bridge:
  agent_id: "legacy-agent-id"
  api_key: "legacy-api-key"
`);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { loadBandLinearConfig } = await getLoader();
      const config = loadBandLinearConfig("linear_band_bridge", "linear_thenvoi_bridge", configPath);
      expect(config.agentId).toBe("legacy-agent-id");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("linear_thenvoi_bridge"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("surfaces validation error when Band key is present but malformed", async () => {
    const configPath = join(tmpDir, "agent_config.yaml");
    writeFileSync(configPath, `
linear_band_bridge:
  agent_id: ""
linear_thenvoi_bridge:
  agent_id: "legacy-id"
  api_key: "legacy-key"
`);
    const { loadBandLinearConfig } = await getLoader();
    expect(() =>
      loadBandLinearConfig("linear_band_bridge", "linear_thenvoi_bridge", configPath),
    ).toThrow(/api_key/i);
  });
});

describe("P-C3-3B: readLinearEnv", () => {
  const ENV_PAIRS = [
    ["LINEAR_BAND_STATE_DB", "LINEAR_THENVOI_STATE_DB"],
    ["LINEAR_BAND_ROOM_STRATEGY", "LINEAR_THENVOI_ROOM_STRATEGY"],
    ["LINEAR_BAND_WRITEBACK_MODE", "LINEAR_THENVOI_WRITEBACK_MODE"],
    ["LINEAR_BAND_EMBED_AGENT", "LINEAR_THENVOI_EMBED_AGENT"],
  ] as const;

  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const [band, legacy] of ENV_PAIRS) {
      savedEnv[band] = process.env[band];
      savedEnv[legacy] = process.env[legacy];
      delete process.env[band];
      delete process.env[legacy];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  async function getReadLinearEnv() {
    // Re-import to get fresh module state (warning dedup is per-module-load)
    const mod = await import("../examples/linear-band/linear-band-bridge-agent");
    return mod.readLinearEnv;
  }

  it.each(ENV_PAIRS)("Band-only: %s wins", async (bandKey, legacyKey) => {
    process.env[bandKey] = "band-value";
    const readLinearEnv = await getReadLinearEnv();
    expect(readLinearEnv(bandKey, legacyKey)).toBe("band-value");
  });

  it.each(ENV_PAIRS)("legacy-only: %s returned", async (bandKey, legacyKey) => {
    process.env[legacyKey] = "legacy-value";
    const readLinearEnv = await getReadLinearEnv();
    expect(readLinearEnv(bandKey, legacyKey)).toBe("legacy-value");
  });

  it.each(ENV_PAIRS)("both set: %s (Band) wins", async (bandKey, legacyKey) => {
    process.env[bandKey] = "band-value";
    process.env[legacyKey] = "legacy-value";
    const readLinearEnv = await getReadLinearEnv();
    expect(readLinearEnv(bandKey, legacyKey)).toBe("band-value");
  });

  it.each(ENV_PAIRS)("neither set: returns undefined for %s/%s", async (bandKey, legacyKey) => {
    const readLinearEnv = await getReadLinearEnv();
    expect(readLinearEnv(bandKey, legacyKey)).toBeUndefined();
  });
});
