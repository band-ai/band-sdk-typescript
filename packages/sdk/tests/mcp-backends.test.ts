import { afterEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createBandMcpBackend } from "../src/mcp/backends";
import { FakeRestApi, FakeTools } from "./testUtils";

describe("createBandMcpBackend", () => {
  const backends: Array<{ stop(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(backends.map(async (backend) => {
      await backend.stop();
    }));
    backends.length = 0;
  });

  it("creates an sdk backend with allowed tools", async () => {
    const tools = new FakeTools();
    tools.rest = new FakeRestApi({
      listChats: async () => ({ data: [{ id: "room-1", title: "Room" }] }),
    }, {
      id: "agent-1",
      name: "Agent",
      handle: "@owner/agent",
      description: null,
    });
    tools.getParticipants = async () => [
      { id: "agent-1", name: "Agent", type: "Agent", handle: "@owner/agent" },
    ];

    const backend = await createBandMcpBackend({
      kind: "sdk",
      enableMemoryTools: false,
      getToolsForRoom: () => tools,
    });
    backends.push(backend);

    expect(backend.kind).toBe("sdk");
    expect(backend.allowedTools).toContain("mcp__band__band_send_message");

    const context = await (backend.server as { getSystemPromptContext: (roomId: string) => Promise<string> }).getSystemPromptContext("room-1");
    expect(context).toContain("Room");
    expect(context).toContain("@owner/agent");
  });

  it("creates a single-room sdk backend without requiring room-scoped execution", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const tools = new FakeTools();
    tools.executeToolCall = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { ok: true };
    };

    const backend = await createBandMcpBackend({
      kind: "sdk",
      multiRoom: false,
      enableMemoryTools: false,
      getToolsForRoom: () => tools,
    });
    backends.push(backend);

    expect(backend.kind).toBe("sdk");
    expect(backend.allowedTools).toContain("mcp__band__band_send_message");

    const toolDefinitions = (backend.server as { toolDefinitions: Array<{ name: string; handler: (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<{ isError?: true }> }> }).toolDefinitions;
    const sendMessage = toolDefinitions.find((tool) => tool.name === "band_send_message");
    expect(sendMessage).toBeDefined();
    if (!sendMessage) {
      throw new Error("band_send_message tool definition missing");
    }

    const result = await sendMessage.handler({ content: "hello" }, {});
    expect(result.isError).toBeUndefined();
    expect(calls).toEqual([
      {
        name: "band_send_message",
        args: { content: "hello" },
      },
    ]);
  });

  it("creates an http backend and starts the local server", async () => {
    const backend = await createBandMcpBackend({
      kind: "http",
      enableMemoryTools: false,
      getToolsForRoom: () => new FakeTools(),
    });
    backends.push(backend);

    expect(backend.kind).toBe("http");
    expect(backend.allowedTools).toContain("mcp__band__band_send_message");
    expect(backend.server).toHaveProperty("url");
  });

  it("gives every generation's listener back when the room turns again", async () => {
    // One process per turn means one backend per turn. A stopped generation that
    // keeps its listener — because Node waits for the keep-alive its client left
    // open — would make a long-lived room accumulate ports until the machine runs
    // out, so each stop must finish promptly and its port must refuse again.
    const generations = [];
    for (let turn = 0; turn < 3; turn += 1) {
      generations.push(await createBandMcpBackend({
        kind: "http",
        enableMemoryTools: false,
        getToolsForRoom: () => new FakeTools(),
      }));
    }
    const urls = generations.map((backend) => (backend.server as { url: string }).url);

    // The last turn's client leaves its connection open, as the CLI's does.
    const client = new Client({ name: "lingering-client", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(urls[2]!), {
        requestInit: { headers: { authorization: `Bearer ${generations[2]!.authToken}` } },
      }),
    );
    await client.listTools();

    const stoppedAt = Date.now();
    for (const backend of generations) {
      await backend.stop();
    }
    expect(Date.now() - stoppedAt, "a stopped generation held its listener open").toBeLessThan(1_000);

    for (const url of urls) {
      await expect(fetch(new URL("/healthz", url))).rejects.toThrow();
    }
  });

  it("issues an auth token for the http backend and rejects unauthenticated requests", async () => {
    const backend = await createBandMcpBackend({
      kind: "http",
      enableMemoryTools: false,
      getToolsForRoom: () => new FakeTools(),
    });
    backends.push(backend);

    expect(backend.authToken).toMatch(/^[0-9a-f]{64}$/);

    const url = (backend.server as { url: string }).url;

    const unauth = await new Client({ name: "attacker", version: "1.0.0" })
      .connect(new StreamableHTTPClientTransport(new URL(url)))
      .then(() => "connected", (error) => error);
    expect(unauth).toBeInstanceOf(Error);

    const client = new Client({ name: "verify-client", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${backend.authToken}` } },
    }));
    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);
  });

  it("creates an sse backend and starts the local server", async () => {
    const backend = await createBandMcpBackend({
      kind: "sse",
      enableMemoryTools: false,
      getToolsForRoom: () => new FakeTools(),
    });
    backends.push(backend);

    expect(backend.kind).toBe("sse");
    expect(backend.allowedTools).toContain("mcp__band__band_send_message");
    expect(backend.server).toHaveProperty("sseUrl");
  });
});
