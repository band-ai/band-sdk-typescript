/**
 * P-C3 proof tests: config/env Band-first compatibility, export renames,
 * compile proofs, dispatch reuse, and legacy fallback behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync, existsSync, mkdirSync, cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import type { Logger } from "../src/core";

import {
  handleAgentSessionEvent,
  createSqliteSessionRoomStore,
} from "../src/linear";
import { LinearBandExampleRestApi } from "../examples/linear-band/linear-band-rest-stub";

const SDK_ROOT = resolve(__dirname, "..");

// Module namespace types for the example entry modules. A top-level `typeof
// import()` alias is the canonical way to type a dynamically-imported module;
// it is not an inline signature annotation.
type AgentModule = typeof import("../examples/linear-band/linear-band-bridge-agent");
type ServerModule = typeof import("../examples/linear-band/linear-band-bridge-server");

interface FreshModules {
  agent: AgentModule;
  server: ServerModule;
}

// The env/config compatibility helpers carry module-scoped once-per-key warning
// dedup state. Re-import them through a reset module registry so each test sees
// a fresh warning ledger — no production test-only reset API required. Dynamic
// import is required here to observe fresh module state after resetModules; a
// static import binds the singleton once and defeats the isolation.
async function freshModules(): Promise<FreshModules> {
  vi.resetModules();
  const agent = await import("../examples/linear-band/linear-band-bridge-agent");
  const server = await import("../examples/linear-band/linear-band-bridge-server");
  return { agent, server };
}

// ── P-C3-1: Export rename compile proof ──────────────────────────────────────

describe("P-C3-1: new Band type names compile and old names fail", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "c3-compile-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Compile a consumer that resolves `@band-ai/sdk/linear` through the package's
  // real `exports` map under NodeNext — a temp node_modules link, no `paths`
  // alias to a declaration file. `.mts` exercises ESM resolution, `.cts` CJS.
  function compileConsumer(filename: string, code: string): { status: number; output: string } {
    const nmDir = join(tmpDir, "node_modules/@band-ai/sdk");
    mkdirSync(nmDir, { recursive: true });
    cpSync(join(SDK_ROOT, "dist"), join(nmDir, "dist"), { recursive: true });
    cpSync(join(SDK_ROOT, "package.json"), join(nmDir, "package.json"));

    writeFileSync(join(tmpDir, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        strict: true,
        module: "nodenext",
        moduleResolution: "nodenext",
        target: "es2022",
        noEmit: true,
        skipLibCheck: true,
        typeRoots: [join(SDK_ROOT, "node_modules/@types")],
      },
      include: [filename],
    }));
    writeFileSync(join(tmpDir, filename), code);
    const result = spawnSync(
      join(SDK_ROOT, "node_modules/.bin/tsc"),
      ["-p", join(tmpDir, "tsconfig.json")],
      { encoding: "utf8" },
    );
    return { status: result.status ?? 1, output: (result.stdout ?? "") + (result.stderr ?? "") };
  }

  it("ESM consumer: new Band types compile via NodeNext package exports", () => {
    const result = compileConsumer("consumer.mts", `
      import type { LinearBandBridgeConfig, LinearBandBridgeDeps } from "@band-ai/sdk/linear";
      const _cfg = {} as LinearBandBridgeConfig;
      const _deps = {} as LinearBandBridgeDeps;
    `);
    expect(result.status).toBe(0);
  });

  it("ESM consumer: old types fail with missing-export diagnostic", () => {
    const result = compileConsumer("old.mts", `
      import type { LinearThenvoiBridgeConfig } from "@band-ai/sdk/linear";
      const _cfg = {} as LinearThenvoiBridgeConfig;
    `);
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/has no exported member.*LinearThenvoiBridgeConfig/);
  });

  it("CJS consumer: new Band types compile via NodeNext package exports", () => {
    const result = compileConsumer("consumer.cts", `
      import type { LinearBandBridgeConfig, LinearBandBridgeDeps } from "@band-ai/sdk/linear";
      const _cfg = {} as LinearBandBridgeConfig;
      const _deps = {} as LinearBandBridgeDeps;
    `);
    expect(result.status).toBe(0);
  });

  it("CJS consumer: old types fail with missing-export diagnostic", () => {
    const result = compileConsumer("old.cts", `
      import type { LinearThenvoiBridgeConfig } from "@band-ai/sdk/linear";
      const _cfg = {} as LinearThenvoiBridgeConfig;
    `);
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/has no exported member.*LinearThenvoiBridgeConfig/);
  });
});

// ── P-C3-2: Config entry paths ───────────────────────────────────────────────

describe("P-C3-2: config entry paths", () => {
  let tmpDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let loadBandLinearConfig: AgentModule["loadBandLinearConfig"];
  let resolveEmbeddedBridgeConfig: ServerModule["resolveEmbeddedBridgeConfig"];
  let resolveBridgeApiKey: ServerModule["resolveBridgeApiKey"];

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "c3-config-"));
    const { agent, server } = await freshModules();
    loadBandLinearConfig = agent.loadBandLinearConfig;
    resolveEmbeddedBridgeConfig = server.resolveEmbeddedBridgeConfig;
    resolveBridgeApiKey = server.resolveBridgeApiKey;
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    warnSpy.mockRestore();
    delete process.env.LINEAR_BAND_BRIDGE_RUNTIME_CONFIG_KEY;
    delete process.env.LINEAR_THENVOI_BRIDGE_RUNTIME_CONFIG_KEY;
    delete process.env.LINEAR_BAND_BRIDGE_AGENT_CONFIG_KEY;
    delete process.env.LINEAR_THENVOI_BRIDGE_AGENT_CONFIG_KEY;
    delete process.env.THENVOI_API_KEY;
  });

  function writeYaml(content: string): string {
    const path = join(tmpDir, "agent_config.yaml");
    writeFileSync(path, content);
    return path;
  }

  const legacyYaml = `
linear_thenvoi_bridge:
  agent_id: "legacy-id"
  api_key: "legacy-key"
`;

  it("loadBandLinearConfig: Band key loads, no warning", () => {
    const cp = writeYaml(`
linear_band_bridge:
  agent_id: "band-id"
  api_key: "band-key"
`);
    const config = loadBandLinearConfig("linear_band_bridge", "linear_thenvoi_bridge", cp);
    expect(config.agentId).toBe("band-id");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("loadBandLinearConfig: legacy key loads with exactly one warning", () => {
    const cp = writeYaml(legacyYaml);
    const config = loadBandLinearConfig("linear_band_bridge", "linear_thenvoi_bridge", cp);
    expect(config.agentId).toBe("legacy-id");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockClear();
    loadBandLinearConfig("linear_band_bridge", "linear_thenvoi_bridge", cp);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("loadBandLinearConfig: malformed Band key surfaces error", () => {
    const cp = writeYaml(`
linear_band_bridge:
  agent_id: ""
linear_thenvoi_bridge:
  agent_id: "legacy"
  api_key: "key"
`);
    expect(() => loadBandLinearConfig("linear_band_bridge", "linear_thenvoi_bridge", cp)).toThrow(/api_key/i);
  });

  it("resolveEmbeddedBridgeConfig: default loads legacy-only YAML with warning", () => {
    const cp = writeYaml(legacyYaml);
    const config = resolveEmbeddedBridgeConfig(cp);
    expect(config.agentId).toBe("legacy-id");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("linear_thenvoi_bridge"));
  });

  it("resolveEmbeddedBridgeConfig: explicit legacy runtime key warns", () => {
    process.env.LINEAR_BAND_BRIDGE_RUNTIME_CONFIG_KEY = "linear_thenvoi_bridge";
    const cp = writeYaml(legacyYaml);
    const config = resolveEmbeddedBridgeConfig(cp);
    expect(config.agentId).toBe("legacy-id");
    // Warns because the explicit key is a canonical legacy key
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("linear_thenvoi_bridge"));
  });

  it("resolveEmbeddedBridgeConfig: explicit custom key loads exact, no warning", () => {
    process.env.LINEAR_BAND_BRIDGE_RUNTIME_CONFIG_KEY = "my_custom_agent";
    const cp = writeYaml(`
my_custom_agent:
  agent_id: "custom-id"
  api_key: "custom-key"
`);
    const config = resolveEmbeddedBridgeConfig(cp);
    expect(config.agentId).toBe("custom-id");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("resolveBridgeApiKey: non-embedded default loads legacy-only YAML with warning and reports legacy key", () => {
    const cp = writeYaml(legacyYaml);
    const info = vi.fn();
    const logger = { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
    const key = resolveBridgeApiKey(logger, cp);
    expect(key).toBe("legacy-key");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("linear_thenvoi_bridge"));
    // Observability metadata reports the key actually selected (legacy fallback)
    expect(info).toHaveBeenCalledWith("linear_thenvoi_bridge.using_agent_config_key", { configKey: "linear_thenvoi_bridge" });
  });

  it("resolveBridgeApiKey: non-embedded default loads Band YAML and reports Band key", () => {
    const cp = writeYaml(`
linear_band_bridge:
  agent_id: "band-id"
  api_key: "band-key"
`);
    const info = vi.fn();
    const logger = { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
    const key = resolveBridgeApiKey(logger, cp);
    expect(key).toBe("band-key");
    expect(warnSpy).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith("linear_thenvoi_bridge.using_agent_config_key", { configKey: "linear_band_bridge" });
  });

  it("resolveBridgeApiKey: explicit legacy agent config key warns", () => {
    process.env.LINEAR_BAND_BRIDGE_AGENT_CONFIG_KEY = "linear_thenvoi_bridge";
    const cp = writeYaml(legacyYaml);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
    const key = resolveBridgeApiKey(logger, cp);
    expect(key).toBe("legacy-key");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("linear_thenvoi_bridge"));
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
  let readLinearEnv: AgentModule["readLinearEnv"];

  beforeEach(async () => {
    savedEnv = {};
    for (const [band, legacy] of ALL_ENV_PAIRS) {
      savedEnv[band] = process.env[band];
      savedEnv[legacy] = process.env[legacy];
      delete process.env[band];
      delete process.env[legacy];
    }
    ({ agent: { readLinearEnv } } = await freshModules());
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

  it.each(ALL_ENV_PAIRS)("legacy-only: %s warns first, silent second", (bandKey, legacyKey) => {
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

// ── P-C3-3: SQLite path resolution, reuse, and dispatch ──────────────────────

describe("P-C3-3: SQLite dispatch through saved binding", () => {
  let savedStateDb: string | undefined;
  let savedBandStateDb: string | undefined;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let createLinearBandBridgeStore: AgentModule["createLinearBandBridgeStore"];

  beforeEach(async () => {
    savedStateDb = process.env.LINEAR_THENVOI_STATE_DB;
    savedBandStateDb = process.env.LINEAR_BAND_STATE_DB;
    delete process.env.LINEAR_THENVOI_STATE_DB;
    delete process.env.LINEAR_BAND_STATE_DB;
    ({ agent: { createLinearBandBridgeStore } } = await freshModules());
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (savedStateDb === undefined) delete process.env.LINEAR_THENVOI_STATE_DB;
    else process.env.LINEAR_THENVOI_STATE_DB = savedStateDb;
    if (savedBandStateDb === undefined) delete process.env.LINEAR_BAND_STATE_DB;
    else process.env.LINEAR_BAND_STATE_DB = savedBandStateDb;
  });

  function makePayload(sessionId: string, issueId: string) {
    return {
      action: "created",
      type: "AgentSessionEvent",
      agentSession: {
        id: sessionId,
        issue: { id: issueId, identifier: "TEST-1", title: "Test", url: "https://linear.app/test", priority: 2, state: { name: "In Progress", type: "started" }, team: { id: "team-1", key: "TEST", name: "Test" } },
        delegate: { id: "agent-1", name: "Agent", displayName: "Agent" },
        delegateId: "agent-1",
        team: { id: "team-1", key: "TEST", name: "Test" },
      },
    };
  }

  it("dispatch uses the saved room from default-path store, no createChat, no warning", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "c3-dispatch-default-"));
    const dbPath = join(tmpDir, ".linear-thenvoi-example.sqlite");
    const originalCwd = process.cwd();

    try {
      process.chdir(tmpDir);

      // Preseed the DB with a binding
      const seedStore = createSqliteSessionRoomStore(dbPath);
      const now = new Date().toISOString();
      await seedStore.upsert({
        linearSessionId: "session-1",
        linearIssueId: "issue-1",
        bandRoomId: "room-saved",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      await seedStore.close?.();

      // Reopen through the resolver and dispatch. Default path — no legacy env,
      // so no deprecation warning fires.
      const store = createLinearBandBridgeStore();
      const restApi = new LinearBandExampleRestApi();

      await handleAgentSessionEvent({
        payload: makePayload("session-1", "issue-1") as never,
        config: { linearAccessToken: "test", linearWebhookSecret: "test", roomStrategy: "issue" },
        deps: { bandRest: restApi, linearClient: { agentSessionUpdateExternalUrl: vi.fn(async () => ({})) } as never, store },
      });

      // The forwarded message uses the saved room, not a new one
      expect(restApi.roomMessages.length + restApi.roomEvents.length).toBeGreaterThan(0);
      const allRoomIds = [...restApi.roomMessages, ...restApi.roomEvents].map((m) => m.roomId);
      expect(allRoomIds.every((id) => id === "room-saved")).toBe(true);

      // createChat was never called (no new room created)
      expect(restApi.createChatCalls).toHaveLength(0);

      // Default path uses no legacy env, so no deprecation warning
      expect(warnSpy).not.toHaveBeenCalled();

      await store.close?.();
    } finally {
      process.chdir(originalCwd);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("legacy STATE_DB dispatch uses saved room from custom path, no default DB, warns once", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "c3-dispatch-legacy-"));
    const customPath = join(tmpDir, "custom.sqlite");
    const defaultPath = join(tmpDir, ".linear-thenvoi-example.sqlite");

    process.env.LINEAR_THENVOI_STATE_DB = customPath;

    try {
      // Preseed custom DB
      const seedStore = createSqliteSessionRoomStore(customPath);
      const now = new Date().toISOString();
      await seedStore.upsert({
        linearSessionId: "session-2",
        linearIssueId: "issue-2",
        bandRoomId: "room-custom",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      await seedStore.close?.();

      // Open through resolver (picks up legacy env → exactly one deprecation warning)
      const store = createLinearBandBridgeStore();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("LINEAR_THENVOI_STATE_DB"));

      const restApi = new LinearBandExampleRestApi();

      await handleAgentSessionEvent({
        payload: makePayload("session-2", "issue-2") as never,
        config: { linearAccessToken: "test", linearWebhookSecret: "test", roomStrategy: "issue" },
        deps: { bandRest: restApi, linearClient: { agentSessionUpdateExternalUrl: vi.fn(async () => ({})) } as never, store },
      });

      // Forwarding actually happened (guards against a vacuous every([]) pass)
      expect(restApi.roomMessages.length + restApi.roomEvents.length).toBeGreaterThan(0);
      const allRoomIds = [...restApi.roomMessages, ...restApi.roomEvents].map((m) => m.roomId);
      expect(allRoomIds.every((id) => id === "room-custom")).toBe(true);
      expect(restApi.createChatCalls).toHaveLength(0);
      expect(existsSync(defaultPath)).toBe(false);

      await store.close?.();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
