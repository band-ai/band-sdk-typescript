import { afterEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { BandMcpServer } from "../src/mcp/server";
import { FakeTools } from "./testUtils";

describe("BandMcpServer", () => {
  const servers: BandMcpServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.map(async (server) => {
      await server.stop();
    }));
    servers.length = 0;
  });

  it("handles multiple MCP requests on the same client session", async () => {
    const server = new BandMcpServer({
      tools: new FakeTools(),
    });
    servers.push(server);

    await server.start();

    const transport = new StreamableHTTPClientTransport(new URL(server.url!));
    const client = new Client({
      name: "test-client",
      version: "1.0.0",
    });

    await client.connect(transport);

    const first = await client.listTools();
    const second = await client.listTools();

    expect(first.tools.length).toBeGreaterThan(0);
    expect(second.tools.length).toBe(first.tools.length);

    await transport.close();
  });

  it("keeps independent MCP sessions isolated across clients", async () => {
    const server = new BandMcpServer({
      tools: new FakeTools(),
    });
    servers.push(server);

    await server.start();

    const transportA = new StreamableHTTPClientTransport(new URL(server.url!));
    const transportB = new StreamableHTTPClientTransport(new URL(server.url!));
    const clientA = new Client({ name: "client-a", version: "1.0.0" });
    const clientB = new Client({ name: "client-b", version: "1.0.0" });

    await clientA.connect(transportA);
    await clientB.connect(transportB);

    expect(transportA.sessionId).toBeTruthy();
    expect(transportB.sessionId).toBeTruthy();
    expect(transportA.sessionId).not.toBe(transportB.sessionId);

    const [toolsA, toolsB] = await Promise.all([
      clientA.listTools(),
      clientB.listTools(),
    ]);

    expect(toolsA.tools.length).toBeGreaterThan(0);
    expect(toolsB.tools.length).toBe(toolsA.tools.length);

    await transportA.close();
    await transportB.close();
  });

  it("rejects unknown session ids", async () => {
    const server = new BandMcpServer({
      tools: new FakeTools(),
    });
    servers.push(server);

    await server.start();

    const response = await fetch(server.url!, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-session-id": "missing-session",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        message: "Session not found",
      },
    });
  });
});
