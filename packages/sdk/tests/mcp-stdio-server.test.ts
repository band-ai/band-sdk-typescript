import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, Notification } from "@modelcontextprotocol/sdk/types.js";

import { BandMcpStdioServer, type BandMcpStdioServerOptions } from "../src/mcp/stdio";
import { FakeTools } from "./testUtils";

/** Client side of the server's stdio pipe, framed the way `StdioServerTransport` frames it. */
class StreamClientTransport implements Transport {
  public onmessage?: (message: JSONRPCMessage) => void;
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  private readonly buffer = new ReadBuffer();

  public constructor(
    private readonly fromServer: PassThrough,
    private readonly toServer: PassThrough,
  ) {}

  public async start(): Promise<void> {
    this.fromServer.on("data", this.onData);
  }

  public async send(message: JSONRPCMessage): Promise<void> {
    this.toServer.write(serializeMessage(message));
  }

  public async close(): Promise<void> {
    this.fromServer.off("data", this.onData);
    this.onclose?.();
  }

  private readonly onData = (chunk: Buffer): void => {
    this.buffer.append(chunk);
    try {
      for (let message = this.buffer.readMessage(); message; message = this.buffer.readMessage()) {
        this.onmessage?.(message);
      }
    } catch (error) {
      this.onerror?.(error as Error);
    }
  };
}

describe("BandMcpStdioServer", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.map((cleanup) => cleanup()));
    cleanups.length = 0;
  });

  function createServer(options: Partial<BandMcpStdioServerOptions> = {}) {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = new BandMcpStdioServer({ tools: new FakeTools(), stdin, stdout, ...options });
    cleanups.push(() => server.stop());
    return { server, stdin, stdout };
  }

  async function connect(stdin: PassThrough, stdout: PassThrough): Promise<Client> {
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(new StreamClientTransport(stdout, stdin));
    cleanups.push(() => client.close());
    return client;
  }

  it("advertises the configured capabilities and instructions", async () => {
    const { server, stdin, stdout } = createServer({
      capabilities: { experimental: { "test/ext": {} } },
      instructions: "Reply through the tools.",
    });
    await server.start();

    const client = await connect(stdin, stdout);

    expect(client.getServerCapabilities()?.experimental).toEqual({ "test/ext": {} });
    expect(client.getInstructions()).toBe("Reply through the tools.");
  });

  it("delivers a custom notification to the client", async () => {
    const { server, stdin, stdout } = createServer();
    await server.start();
    const client = await connect(stdin, stdout);
    const received = new Promise<Notification>((resolve) => {
      client.fallbackNotificationHandler = async (notification) => resolve(notification);
    });

    await server.notify("notifications/x", { content: "hi", meta: { room_id: "r1" } });

    expect(await received).toEqual({
      jsonrpc: "2.0",
      method: "notifications/x",
      params: { content: "hi", meta: { room_id: "r1" } },
    });
  });

  it("rejects notify before start", async () => {
    const { server } = createServer();

    await expect(server.notify("notifications/x")).rejects.toThrow("not started");
  });

  it("keeps the default handshake and tools without the new options", async () => {
    const { server, stdin, stdout } = createServer();
    await server.start();

    const client = await connect(stdin, stdout);

    expect(client.getInstructions()).toBeUndefined();
    expect(client.getServerCapabilities()?.experimental).toBeUndefined();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(server.toolNames);
  });
});
