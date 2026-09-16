/**
 * P-C3 proof tests: config/env Band-first compatibility, export renames,
 * compile proofs, dispatch reuse, and legacy fallback removal (INT-1343).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync, mkdirSync, cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { ValidationError, type Logger } from "../src/core";

import {
  handleAgentSessionEvent,
  createSqliteSessionRoomStore,
} from "../src/linear";
import { LinearBandExampleRestApi } from "../examples/linear-band/linear-band-rest-stub";
import { readLinearEnv, createLinearBandBridgeStore } from "../examples/linear-band/linear-band-bridge-agent";
import { resolveEmbeddedBridgeConfig, resolveBridgeApiKey } from "../examples/linear-band/linear-band-bridge-server";

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

// ── P-C3-2: Config entry paths (legacy key/alias fully removed, INT-1343) ────

describe("P-C3-2: config entry paths", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "c3-config-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.LINEAR_BAND_BRIDGE_RUNTIME_CONFIG_KEY;
    delete process.env.LINEAR_BAND_BRIDGE_AGENT_CONFIG_KEY;
  });

  function writeYaml(content: string): string {
    const path = join(tmpDir, "agent_config.yaml");
    writeFileSync(path, content);
    return path;
  }

  it("resolveEmbeddedBridgeConfig: default with no linear_band_bridge section fails", () => {
    const cp = writeYaml(`
other_agent:
  agent_id: "other-id"
  api_key: "other-key"
`);
    expect(() => resolveEmbeddedBridgeConfig(cp)).toThrow(ValidationError);
  });

  it("resolveEmbeddedBridgeConfig: explicit custom key loads exact", () => {
    process.env.LINEAR_BAND_BRIDGE_RUNTIME_CONFIG_KEY = "my_custom_agent";
    const cp = writeYaml(`
my_custom_agent:
  agent_id: "custom-id"
  api_key: "custom-key"
`);
    const config = resolveEmbeddedBridgeConfig(cp);
    expect(config.agentId).toBe("custom-id");
  });

  it("resolveBridgeApiKey: default with no linear_band_bridge section and no env fallback throws Missing API key", () => {
    const cp = writeYaml(`
other_agent:
  agent_id: "other-id"
  api_key: "other-key"
`);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
    expect(() => resolveBridgeApiKey(logger, cp)).toThrow(/Missing API key/);
  });

  it("resolveBridgeApiKey: default loads Band YAML and reports Band key", () => {
    const cp = writeYaml(`
linear_band_bridge:
  agent_id: "band-id"
  api_key: "band-key"
`);
    const info = vi.fn();
    const logger = { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
    const key = resolveBridgeApiKey(logger, cp);
    expect(key).toBe("band-key");
    expect(info).toHaveBeenCalledWith("linear_thenvoi_bridge.using_agent_config_key", { configKey: "linear_band_bridge" });
  });

  it("resolveBridgeApiKey: explicit custom key loads exact", () => {
    process.env.LINEAR_BAND_BRIDGE_AGENT_CONFIG_KEY = "my_custom_agent";
    const cp = writeYaml(`
my_custom_agent:
  agent_id: "custom-id"
  api_key: "custom-key"
`);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
    const key = resolveBridgeApiKey(logger, cp);
    expect(key).toBe("custom-key");
  });
});

// ── P-C3-3B: readLinearEnv ────────────────────────────────────────────────

describe("P-C3-3B: readLinearEnv", () => {
  const BAND_KEY = "LINEAR_BAND_STATE_DB";

  let savedBand: string | undefined;

  beforeEach(() => {
    savedBand = process.env[BAND_KEY];
    delete process.env[BAND_KEY];
  });

  afterEach(() => {
    if (savedBand === undefined) delete process.env[BAND_KEY];
    else process.env[BAND_KEY] = savedBand;
  });

  it("returns the trimmed value when set", () => {
    process.env[BAND_KEY] = "  band-value  ";
    expect(readLinearEnv(BAND_KEY)).toBe("band-value");
  });

  it("returns undefined when unset", () => {
    expect(readLinearEnv(BAND_KEY)).toBeUndefined();
  });
});

// ── P-C3-3: SQLite path resolution, reuse, and dispatch ──────────────────────

describe("P-C3-3: SQLite dispatch through saved binding", () => {
  let savedBandStateDb: string | undefined;

  beforeEach(() => {
    savedBandStateDb = process.env.LINEAR_BAND_STATE_DB;
    delete process.env.LINEAR_BAND_STATE_DB;
  });

  afterEach(() => {
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

  it("dispatch uses the saved room from default-path store, no createChat", async () => {
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

      // Reopen through the resolver and dispatch
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

      await store.close?.();
    } finally {
      process.chdir(originalCwd);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
