import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVER_ENTRY = join(PKG_ROOT, "dist", "server.js");

/**
 * Speaks real MCP over stdio to the *built* dist/server.js — not the source,
 * so this also proves the tsup bundle (task #7) actually works end to end.
 *
 * server.ts calls `server.start()` (the MCP stdio transport) before
 * `link.connect()` (Band), so the MCP handshake below doesn't need a working
 * Band connection — it only needs the process to stay alive long enough to
 * answer. A local WebSocket server that accepts the connection but never
 * completes Phoenix's channel join keeps `link.connect()` pending (Phoenix
 * waits on a join reply that never comes) well past this test's duration,
 * without needing real Band credentials.
 */
describe("dist/server.js stdio smoke test", () => {
  let wss: InstanceType<typeof WebSocketServer>;
  let wsUrl: string;
  const clients: Client[] = [];

  beforeAll(async () => {
    if (!existsSync(SERVER_ENTRY)) {
      throw new Error(`dist/server.js is missing: ${SERVER_ENTRY} (run \`pnpm --filter @band-ai/claude-code-plugin build\`)`);
    }

    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    wsUrl = `ws://127.0.0.1:${wss.address().port}/socket`;

    return () =>
      new Promise<void>((resolve, reject) => {
        wss.close((error) => (error ? reject(error) : resolve()));
      });
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  async function connectClient(): Promise<Client> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_ENTRY],
      env: {
        PATH: process.env.PATH ?? "",
        BAND_AGENT_ID: "00000000-0000-0000-0000-000000000000",
        BAND_API_KEY: "smoke-test-key",
        BAND_WS_URL: wsUrl,
        BAND_REST_URL: "http://127.0.0.1:1",
      },
    });
    const client = new Client({ name: "smoke-test-client", version: "1.0.0" });
    await client.connect(transport);
    clients.push(client);
    return client;
  }

  it("initialize returns the claude/channel experimental capability and instructions", async () => {
    const client = await connectClient();

    const capabilities = client.getServerCapabilities();
    expect(capabilities?.experimental).toMatchObject({ "claude/channel": {} });
    expect(capabilities?.tools).toBeDefined();

    const instructions = client.getInstructions();
    expect(typeof instructions).toBe("string");
    expect(instructions).toContain("channel");
  });

  it("tools/list returns the Band tools", async () => {
    const client = await connectClient();

    const result = await client.listTools();
    const toolNames = result.tools.map((tool) => tool.name);

    expect(toolNames).toContain("band_send_message");
    expect(toolNames).toContain("band_send_event");
    expect(toolNames).toContain("band_get_participants");
    expect(toolNames.length).toBeGreaterThan(0);
  });

  it("writes nothing but valid, newline-delimited JSON-RPC frames to stdout", async () => {
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      env: {
        PATH: process.env.PATH ?? "",
        BAND_AGENT_ID: "00000000-0000-0000-0000-000000000000",
        BAND_API_KEY: "smoke-test-key",
        BAND_WS_URL: wsUrl,
        BAND_REST_URL: "http://127.0.0.1:1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "raw-smoke-test", version: "1.0.0" },
      },
    };
    child.stdin.write(JSON.stringify(request) + "\n");

    // Give the process a moment to answer, then tear it down regardless of
    // whether Band ever connects — this test only cares about stdout.
    await new Promise((resolve) => setTimeout(resolve, 500));
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));

    const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
