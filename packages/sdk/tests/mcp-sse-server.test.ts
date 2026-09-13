import { afterEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

import { BandMcpSseServer } from "../src/mcp/sse";
import { FakeTools } from "./testUtils";

describe("BandMcpSseServer", () => {
  const servers: BandMcpSseServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.map(async (server) => {
      await server.stop();
    }));
    servers.length = 0;
  });

  it("serves tools with no authToken configured", async () => {
    const server = new BandMcpSseServer({
      tools: new FakeTools(),
    });
    servers.push(server);

    await server.start();

    const transport = new SSEClientTransport(new URL(server.sseUrl!));
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await client.connect(transport);
    const result = await client.listTools();

    expect(result.tools.length).toBeGreaterThan(0);

    await transport.close();
  });

  it("rejects an SSE connection without a bearer token when authToken is configured", async () => {
    const server = new BandMcpSseServer({
      tools: new FakeTools(),
      authToken: "secret-token",
    });
    servers.push(server);

    await server.start();

    const response = await fetch(server.sseUrl!, {
      headers: { accept: "text/event-stream" },
    });

    expect(response.status).toBe(401);
  });

  it("rejects an SSE connection with the wrong bearer token", async () => {
    const server = new BandMcpSseServer({
      tools: new FakeTools(),
      authToken: "secret-token",
    });
    servers.push(server);

    await server.start();

    const response = await fetch(server.sseUrl!, {
      headers: {
        accept: "text/event-stream",
        authorization: "Bearer wrong-token",
      },
    });

    expect(response.status).toBe(401);
  });

  it("rejects a /messages post without a bearer token when authToken is configured", async () => {
    const server = new BandMcpSseServer({
      tools: new FakeTools(),
      authToken: "secret-token",
    });
    servers.push(server);

    await server.start();

    const messagesUrl = new URL(server.sseUrl!);
    messagesUrl.pathname = "/messages";
    messagesUrl.searchParams.set("sessionId", "irrelevant");

    const response = await fetch(messagesUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

    expect(response.status).toBe(401);
  });

  it("accepts an SSE connection carrying the correct bearer token", async () => {
    const server = new BandMcpSseServer({
      tools: new FakeTools(),
      authToken: "secret-token",
    });
    servers.push(server);

    await server.start();

    const transport = new SSEClientTransport(new URL(server.sseUrl!), {
      eventSourceInit: {
        fetch: (url, init) => {
          const headers = new Headers(init?.headers);
          headers.set("authorization", "Bearer secret-token");
          return fetch(url, { ...init, headers });
        },
      },
      requestInit: {
        headers: { authorization: "Bearer secret-token" },
      },
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await client.connect(transport);
    const result = await client.listTools();

    expect(result.tools.length).toBeGreaterThan(0);

    await transport.close();
  });
});
