/**
 * P-C3 proof tests: config/env Band-first compatibility, export renames,
 * and legacy fallback behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import {
  readLinearEnv,
  loadBandLinearConfig,
  createLinearBandBridgeStore,
  _resetWarningState,
} from "../examples/linear-band/linear-band-bridge-agent";

const SDK_ROOT = resolve(__dirname, "..");

// ── P-C3-1: Export rename compile proof ──────────────────────────────────────

describe("P-C3-1: new Band type names compile and old names fail", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "c3-compile-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeTsconfig(includes: string[]): void {
    writeFileSync(join(tmpDir, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        strict: true,
        moduleResolution: "bundler",
        module: "esnext",
        target: "es2022",
        noEmit: true,
        skipLibCheck: true,
        typeRoots: [join(SDK_ROOT, "node_modules/@types")],
        baseUrl: SDK_ROOT,
        paths: { "@thenvoi/sdk/linear": ["dist/linear.d.ts"] },
      },
      include: includes,
    }));
  }

  function compile(filename: string, code: string): { status: number; output: string } {
    writeFileSync(join(tmpDir, filename), code);
    writeTsconfig([filename]);
    const result = spawnSync(
      join(SDK_ROOT, "node_modules/.bin/tsc"),
      ["-p", join(tmpDir, "tsconfig.json")],
      { encoding: "utf8" },
    );
    return { status: result.status ?? 1, output: (result.stdout ?? "") + (result.stderr ?? "") };
  }

  it("ESM consumer importing new Band types compiles successfully", () => {
    const result = compile("consumer.mts", `
      import type { LinearBandBridgeConfig, LinearBandBridgeDeps } from "@thenvoi/sdk/linear";
      const _cfg: LinearBandBridgeConfig = {} as LinearBandBridgeConfig;
      const _deps: LinearBandBridgeDeps = {} as LinearBandBridgeDeps;
    `);
    expect(result.status).toBe(0);
  });

  it("CTS consumer importing new Band types compiles successfully", () => {
    const result = compile("consumer.cts", `
      import type { LinearBandBridgeConfig, LinearBandBridgeDeps } from "@thenvoi/sdk/linear";
      const _cfg: LinearBandBridgeConfig = {} as LinearBandBridgeConfig;
      const _deps: LinearBandBridgeDeps = {} as LinearBandBridgeDeps;
    `);
    expect(result.status).toBe(0);
  });

  it("old LinearThenvoi type import fails with missing-export diagnostic", () => {
    const result = compile("old-consumer.mts", `
      import type { LinearThenvoiBridgeConfig } from "@thenvoi/sdk/linear";
      const _cfg: LinearThenvoiBridgeConfig = {} as LinearThenvoiBridgeConfig;
    `);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("LinearThenvoiBridgeConfig");
  });
});

// ── P-C3-2: loadBandLinearConfig ─────────────────────────────────────────────

describe("P-C3-2: loadBandLinearConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "c3-config-"));
    _resetWarningState();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads Band-key config when present", () => {
    const configPath = join(tmpDir, "agent_config.yaml");
    writeFileSync(configPath, [
      "linear_band_bridge:",
      '  agent_id: "band-agent-id"',
      '  api_key: "band-api-key"',
    ].join("\n"));
    const config = loadBandLinearConfig("linear_band_bridge", "linear_thenvoi_bridge", configPath);
    expect(config.agentId).toBe("band-agent-id");
  });

  it("falls back to legacy key with exactly one warning, not two", () => {
    const configPath = join(tmpDir, "agent_config.yaml");
    writeFileSync(configPath, [
      "linear_thenvoi_bridge:",
      '  agent_id: "legacy-agent-id"',
      '  api_key: "legacy-api-key"',
    ].join("\n"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // First call: warns
      const config = loadBandLinearConfig("linear_band_bridge", "linear_thenvoi_bridge", configPath);
      expect(config.agentId).toBe("legacy-agent-id");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("linear_thenvoi_bridge"));

      // Second call: no additional warning
      warnSpy.mockClear();
      loadBandLinearConfig("linear_band_bridge", "linear_thenvoi_bridge", configPath);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("surfaces validation error when Band key is present but malformed", () => {
    const configPath = join(tmpDir, "agent_config.yaml");
    writeFileSync(configPath, [
      "linear_band_bridge:",
      '  agent_id: ""',
      "linear_thenvoi_bridge:",
      '  agent_id: "legacy-id"',
      '  api_key: "legacy-key"',
    ].join("\n"));
    expect(() =>
      loadBandLinearConfig("linear_band_bridge", "linear_thenvoi_bridge", configPath),
    ).toThrow(/api_key/i);
  });
});

// ── P-C3-3B: readLinearEnv — all 10 pairs, warning contracts ─────────────────

describe("P-C3-3B: readLinearEnv", () => {
  const ALL_ENV_PAIRS: ReadonlyArray<readonly [string, string]> = [
    ["LINEAR_BAND_STATE_DB", "LINEAR_THENVOI_STATE_DB"],
    ["LINEAR_BAND_ROOM_STRATEGY", "LINEAR_THENVOI_ROOM_STRATEGY"],
    ["LINEAR_BAND_WRITEBACK_MODE", "LINEAR_THENVOI_WRITEBACK_MODE"],
    ["LINEAR_BAND_EMBED_AGENT", "LINEAR_THENVOI_EMBED_AGENT"],
    ["LINEAR_BAND_ROOM_RESET_TIMEOUT_MS", "LINEAR_THENVOI_ROOM_RESET_TIMEOUT_MS"],
    ["LINEAR_BAND_BRIDGE_AGENT_CONFIG_KEY", "LINEAR_THENVOI_BRIDGE_AGENT_CONFIG_KEY"],
    ["LINEAR_BAND_BRIDGE_RUNTIME_CONFIG_KEY", "LINEAR_THENVOI_BRIDGE_RUNTIME_CONFIG_KEY"],
    ["LINEAR_BAND_DISPATCH_RETRY_LIMIT", "LINEAR_THENVOI_DISPATCH_RETRY_LIMIT"],
    ["LINEAR_BAND_DISPATCH_RETRY_BASE_DELAY_MS", "LINEAR_THENVOI_DISPATCH_RETRY_BASE_DELAY_MS"],
    ["LINEAR_BAND_BRIDGE_MIN_REQUEST_INTERVAL_MS", "LINEAR_THENVOI_BRIDGE_MIN_REQUEST_INTERVAL_MS"],
  ];

  let savedEnv: Record<string, string | undefined>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    savedEnv = {};
    for (const [band, legacy] of ALL_ENV_PAIRS) {
      savedEnv[band] = process.env[band];
      savedEnv[legacy] = process.env[legacy];
      delete process.env[band];
      delete process.env[legacy];
    }
    _resetWarningState();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    warnSpy.mockRestore();
  });

  it.each(ALL_ENV_PAIRS)("Band-only: %s returns Band value, no warning", (bandKey, legacyKey) => {
    process.env[bandKey] = "band-value";
    expect(readLinearEnv(bandKey, legacyKey)).toBe("band-value");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each(ALL_ENV_PAIRS)("legacy-only: %s warns on first read, silent on second", (bandKey, legacyKey) => {
    process.env[legacyKey] = "legacy-value";
    expect(readLinearEnv(bandKey, legacyKey)).toBe("legacy-value");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(legacyKey));
    warnSpy.mockClear();
    expect(readLinearEnv(bandKey, legacyKey)).toBe("legacy-value");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each(ALL_ENV_PAIRS)("both set: %s (Band) wins, no warning", (bandKey, legacyKey) => {
    process.env[bandKey] = "band-value";
    process.env[legacyKey] = "legacy-value";
    expect(readLinearEnv(bandKey, legacyKey)).toBe("band-value");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each(ALL_ENV_PAIRS)("neither set: returns undefined, no warning", (bandKey, legacyKey) => {
    expect(readLinearEnv(bandKey, legacyKey)).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ── P-C3-3: SQLite path resolution and reuse ─────────────────────────────────

describe("P-C3-3: SQLite path resolver and binding reuse", () => {
  let savedStateDb: string | undefined;
  let savedBandStateDb: string | undefined;

  beforeEach(() => {
    savedStateDb = process.env.LINEAR_THENVOI_STATE_DB;
    savedBandStateDb = process.env.LINEAR_BAND_STATE_DB;
    delete process.env.LINEAR_THENVOI_STATE_DB;
    delete process.env.LINEAR_BAND_STATE_DB;
    _resetWarningState();
  });

  afterEach(() => {
    if (savedStateDb === undefined) delete process.env.LINEAR_THENVOI_STATE_DB;
    else process.env.LINEAR_THENVOI_STATE_DB = savedStateDb;
    if (savedBandStateDb === undefined) delete process.env.LINEAR_BAND_STATE_DB;
    else process.env.LINEAR_BAND_STATE_DB = savedBandStateDb;
  });

  it("resolves the compatibility default and reuses an existing binding", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "c3-default-db-"));
    const originalCwd = process.cwd();
    try {
      process.chdir(tmpDir);
      const store1 = createLinearBandBridgeStore();
      const now = new Date().toISOString();
      await store1.upsert({
        linearSessionId: "session-1",
        linearIssueId: "issue-1",
        thenvoiRoomId: "room-abc",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      await store1.close?.();

      const store2 = createLinearBandBridgeStore();
      const existing = await store2.getBySessionId("session-1");
      expect(existing).toBeDefined();
      expect(existing!.thenvoiRoomId).toBe("room-abc");
      await store2.close?.();

      expect(existsSync(join(tmpDir, ".linear-thenvoi-example.sqlite"))).toBe(true);
    } finally {
      process.chdir(originalCwd);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("legacy-only LINEAR_THENVOI_STATE_DB resolves to custom path, no default DB", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "c3-legacy-db-"));
    const customPath = join(tmpDir, "custom-legacy.sqlite");
    const defaultPath = join(tmpDir, ".linear-thenvoi-example.sqlite");

    process.env.LINEAR_THENVOI_STATE_DB = customPath;

    try {
      const store = createLinearBandBridgeStore();
      const now = new Date().toISOString();
      await store.upsert({
        linearSessionId: "session-legacy",
        linearIssueId: "issue-legacy",
        thenvoiRoomId: "room-legacy",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      await store.close?.();

      expect(existsSync(customPath)).toBe(true);
      expect(existsSync(defaultPath)).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
