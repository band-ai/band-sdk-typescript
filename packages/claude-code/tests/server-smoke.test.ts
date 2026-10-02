import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVER_ENTRY = join(PKG_ROOT, "dist", "server.js");
let testHome: string;

function serverEnvironment(sessionId: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: testHome,
    XDG_DATA_HOME: testHome,
    APPDATA: testHome,
    BAND_PLATFORM_URL: "http://127.0.0.1:9",
    CLAUDE_CODE_SESSION_ID: sessionId,
    CLAUDE_PROJECT_DIR: PKG_ROOT,
  };
}

/**
 * Speaks real MCP over stdio to the built dist/server.js. A signed-out server
 * must initialize without Band credentials or network access so its browser
 * authentication and identity-selection tools remain available.
 */
describe("dist/server.js stdio smoke test", () => {
  const clients: Client[] = [];

  beforeAll(async () => {
    testHome = await mkdtemp(join(tmpdir(), "band-plugin-smoke-"));
    if (!existsSync(SERVER_ENTRY)) {
      throw new Error(
        `dist/server.js is missing: ${SERVER_ENTRY} (run \`pnpm --filter @band-ai/claude-code-plugin build\`)`,
      );
    }
  });

  afterAll(async () => {
    await rm(testHome, { recursive: true, force: true });
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  async function connectClient(): Promise<Client> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_ENTRY],
      env: serverEnvironment("00000000-0000-4000-8000-000000000001"),
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

    expect(toolNames).toContain("band_connection_status");
    expect(toolNames).toContain("band_authenticate");
    expect(toolNames).toContain("band_connect_session");
    expect(toolNames).toContain("band_send_message");
  });

  it("writes nothing but valid, newline-delimited JSON-RPC frames to stdout", async () => {
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      env: serverEnvironment("00000000-0000-4000-8000-000000000002"),
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

    await new Promise<void>((resolve) => {
      const waitForFrame = (): void => {
        if (stdout.includes("\n")) {
          resolve();
          return;
        }
        child.stdout.once("data", waitForFrame);
      };
      waitForFrame();
    });
    const exited = once(child, "exit");
    child.stdin.end();
    await exited;

    const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
