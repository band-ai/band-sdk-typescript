import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import pkg from "../package.json" with { type: "json" };
import { BandMcpServer } from "../src/mcp/server";
import type { Logger } from "../src/core/logger";
import { FakeTools } from "./testUtils";

const SDK_ROOT = resolve(__dirname, "..");

describe("every optional peer is externalized in the tsup config", () => {
  // A peer that is not externalized gets bundled into dist, which both bloats the package
  // and defeats the optional-peer contract. Reading the config as text keeps this honest
  // without importing tsup's ESM config into the test runner.
  const configSource = readFileSync(resolve(SDK_ROOT, "tsup.config.ts"), "utf-8");
  const externalBlock = /const EXTERNAL = \[([\s\S]*?)\];/.exec(configSource);

  const externals: string[] = externalBlock
    ? [...externalBlock[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!)
    : [];

  const peers = Object.keys(pkg.peerDependencies ?? {});

  it("finds the EXTERNAL array and a non-empty peerDependencies map", () => {
    expect(externals.length).toBeGreaterThan(0);
    expect(peers.length).toBeGreaterThan(0);
  });

  it.each(peers)("%s is externalized (directly or via a subpath entry)", (peer) => {
    const covered = externals.some((e) => e === peer || e.startsWith(`${peer}/`));
    expect(covered, `"${peer}" is in peerDependencies but missing from tsup EXTERNAL`).toBe(true);
  });
});

describe("MCP teardown does not abandon sessions when one transport fails", () => {
  interface FakeSession {
    transport: { close: () => Promise<void> };
    mcpServer: { close: () => Promise<void> };
    createdAt: number;
    lastSeenAt: number;
  }

  function capturingLogger() {
    const warns: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: (message: string, context?: Record<string, unknown>) => {
        warns.push({ message, context });
      },
      error: () => {},
    };
    return { logger, warns };
  }

  function makeSession(onClose: () => Promise<void>): FakeSession {
    return {
      transport: { close: onClose },
      mcpServer: { close: async () => {} },
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    };
  }

  it("closes every remaining session and the HTTP server when the first close rejects", async () => {
    const { logger, warns } = capturingLogger();
    const server = new BandMcpServer({ tools: new FakeTools(), logger });
    await server.start();
    expect(server.url).toBeTruthy();

    const closed: string[] = [];
    const sessions = (server as unknown as { sessions: Map<string, FakeSession> }).sessions;
    sessions.clear();
    sessions.set("session-fails", makeSession(async () => {
      closed.push("session-fails");
      throw new Error("transport refused to close");
    }));
    sessions.set("session-b", makeSession(async () => { closed.push("session-b"); }));
    sessions.set("session-c", makeSession(async () => { closed.push("session-c"); }));

    // Must not reject: a failing transport is reported, not propagated.
    await expect(server.stop()).resolves.toBeUndefined();

    // Every session was attempted, not just the ones before the failure.
    expect(closed.sort()).toEqual(["session-b", "session-c", "session-fails"]);

    // The HTTP server still shut down despite the rejection.
    expect(server.url).toBeNull();

    // The failure was reported with the session id, not swallowed.
    expect(warns).toHaveLength(1);
    expect(warns[0]!.context?.sessionId).toBe("session-fails");
    expect(String((warns[0]!.context?.error as Error).message)).toContain("refused to close");
    expect(warns[0]!.context?.operation).toBe("stop");
  }, 30_000);

  it("reports every failure when more than one transport rejects", async () => {
    const { logger, warns } = capturingLogger();
    const server = new BandMcpServer({ tools: new FakeTools(), logger });
    await server.start();

    const sessions = (server as unknown as { sessions: Map<string, FakeSession> }).sessions;
    sessions.clear();
    sessions.set("a", makeSession(async () => { throw new Error("a failed"); }));
    sessions.set("b", makeSession(async () => { throw new Error("b failed"); }));

    await expect(server.stop()).resolves.toBeUndefined();

    expect(warns.map((w) => w.context?.sessionId).sort()).toEqual(["a", "b"]);
  }, 30_000);
});

describe("Linear vertical warnings route through the injected logger", () => {
  function capturingLogger() {
    const warns: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: (message: string, context?: Record<string, unknown>) => {
        warns.push({ message, context });
      },
      error: () => {},
    };
    return { logger, warns };
  }

  it("updatePlan reports a failed updateAgentSession to the logger, not console.warn", async () => {
    const { updatePlan } = await import("../src/integrations/linear/activities");
    const { logger, warns } = capturingLogger();

    const consoleWarn = console.warn;
    const consoleCalls: unknown[][] = [];
    console.warn = (...args: unknown[]) => { consoleCalls.push(args); };

    try {
      const client = {
        createAgentActivity: async () => {},
        updateAgentSession: async () => { throw new Error("session update rejected"); },
      };

      await updatePlan(
        client as unknown as Parameters<typeof updatePlan>[0],
        "session-1",
        [{ title: "step one", status: "pending" }],
        { logger },
      );

      expect(warns).toHaveLength(1);
      expect(warns[0]!.message).toContain("updateAgentSession failed");
      expect(warns[0]!.context?.sessionId).toBe("session-1");
      expect((warns[0]!.context?.error as Error).message).toBe("session update rejected");
      expect(consoleCalls, "nothing should reach console.warn").toEqual([]);
    } finally {
      console.warn = consoleWarn;
    }
  });

  it("createSqliteSessionRoomStore still accepts a bare path (options are optional)", async () => {
    const { createSqliteSessionRoomStore } = await import("../src/integrations/linear/store");
    expect(typeof createSqliteSessionRoomStore).toBe("function");
    // Two arities must both type-check and construct; the store is lazy, so no file is touched.
    expect(() => createSqliteSessionRoomStore("./unused-a.sqlite")).not.toThrow();
    expect(() => createSqliteSessionRoomStore("./unused-b.sqlite", {})).not.toThrow();
  });
});

describe("the injected logger reaches the SDK's own production call sites", () => {
  // Adding a `logger` option is only half the fix: if the SDK's own callers never pass
  // one, the default NoopLogger silently discards everything and the diagnostic is
  // unreachable for any real consumer. For updatePlan this would be strictly worse than
  // the console.warn it replaced, which always printed.

  it("Agent.run() forwards its logger into graceful shutdown", async () => {
    const source = readFileSync(resolve(SDK_ROOT, "src/agent/Agent.ts"), "utf-8");
    const call = /runWithGracefulShutdown\(this,\s*\{([^}]*)\}/s.exec(source);
    expect(call, "runWithGracefulShutdown call not found").not.toBeNull();
    expect(call![1]).toContain("logger");
  });

  it("the Linear update-plan tool forwards its logger into updatePlan", async () => {
    const source = readFileSync(resolve(SDK_ROOT, "src/integrations/linear/tools.ts"), "utf-8");
    const call = /await updatePlan\(([\s\S]*?)\);/.exec(source);
    expect(call, "updatePlan call not found").not.toBeNull();
    expect(call![1]).toContain("logger");
  });

  it("OpencodeAdapter forwards its logger into the MCP backend factory", async () => {
    const source = readFileSync(
      resolve(SDK_ROOT, "src/adapters/opencode/OpencodeAdapter.ts"),
      "utf-8",
    );
    const call = /this\.mcpBackendFactory\(\{([\s\S]*?)\}\);/.exec(source);
    expect(call, "mcpBackendFactory call not found").not.toBeNull();
    expect(call![1]).toContain("logger");
  });

  it("createBandMcpBackend passes a supplied logger through to the MCP server it builds", async () => {
    const { createBandMcpBackend } = await import("../src/mcp/backends");
    const warns: string[] = [];
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: (message: string) => { warns.push(message); },
      error: () => {},
    };

    const backend = await createBandMcpBackend({
      kind: "http",
      enableMemoryTools: false,
      getToolsForRoom: () => new FakeTools(),
      logger,
    });

    // Reach the server the backend built and force a failing teardown; the rejection
    // must surface on the logger we supplied, proving it was threaded all the way down.
    const server = (backend as unknown as { server: { sessions: Map<string, unknown> } }).server;
    server.sessions.set("wired", {
      transport: { close: async () => { throw new Error("boom"); } },
      mcpServer: { close: async () => {} },
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    });

    await backend.stop();

    expect(warns.some((m) => m.includes("Failed to close MCP session transport"))).toBe(true);
  }, 30_000);
});
