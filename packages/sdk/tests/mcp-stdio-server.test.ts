import { once } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { describe, expect, test } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Notification } from "@modelcontextprotocol/sdk/types.js";

import { BandMcpStdioServer, type BandMcpStdioServerOptions } from "../src/mcp/stdio";
import { FakeTools } from "./testUtils";

const METHOD = "notifications/x";
const PARAMS = { content: "hi", meta: { room_id: "r1" } };
const NOTIFICATION = { jsonrpc: "2.0", method: METHOD, params: PARAMS };
const EXPERIMENTAL = { "test/ext": {} };
const INSTRUCTIONS = "Reply through the tools.";
const NOT_RUNNING = "not running";

interface ReceivedNotification {
  notification: Notification;
  afterHandshake: boolean;
}

/** A server and an MCP client joined by an in-process stdio pipe the test can break. */
class StdioPipe {
  public readonly client = new Client({ name: "test-client", version: "1.0.0" });
  private readonly stdin = new PassThrough();
  private readonly toClient = new PassThrough();
  private outputBroken = false;
  private readonly stdout = new Writable({
    write: (chunk, _encoding, callback) => {
      if (this.outputBroken) {
        setImmediate(() => callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })));
        return;
      }
      this.toClient.write(chunk, callback);
    },
  });
  private server: BandMcpStdioServer | null = null;

  public createServer(options: Partial<BandMcpStdioServerOptions> = {}): BandMcpStdioServer {
    this.server = new BandMcpStdioServer({
      tools: new FakeTools(),
      stdin: this.stdin,
      stdout: this.stdout,
      ...options,
    });
    return this.server;
  }

  public async startServer(options?: Partial<BandMcpStdioServerOptions>): Promise<BandMcpStdioServer> {
    const server = this.createServer(options);
    await server.start();
    return server;
  }

  // The SDK's stdio transport takes any stream pair, so it also serves as the client end.
  public async connectClient(): Promise<Client> {
    await this.client.connect(new StdioServerTransport(this.toClient, this.stdin));
    return this.client;
  }

  public nextNotification(): Promise<ReceivedNotification> {
    return new Promise((resolve) => {
      this.client.fallbackNotificationHandler = async (notification) =>
        resolve({ notification, afterHandshake: this.client.getServerCapabilities() !== undefined });
    });
  }

  public async listedToolNames(): Promise<string[]> {
    const { tools } = await this.client.listTools();
    return tools.map((tool) => tool.name);
  }

  public async endInput(): Promise<void> {
    this.stdin.end();
    await once(this.stdin, "end");
  }

  public async closeOutput(): Promise<void> {
    this.stdout.destroy();
    await once(this.stdout, "close");
  }

  /** Every later write fails with EPIPE, the way a pipe whose reader exited does. */
  public breakOutput(): Promise<void> {
    this.outputBroken = true;
    return new Promise((resolve) => this.stdout.once("close", resolve));
  }

  /** A line past the SDK's read-buffer limit makes the transport close itself. */
  public sendOversizedLine(): void {
    this.stdin.write(Buffer.alloc(STDIO_DEFAULT_MAX_BUFFER_SIZE + 1, "a"));
  }

  public async close(): Promise<void> {
    await Promise.all([this.client.close(), this.server?.stop()]);
  }
}

const it = test.extend<{ pipe: StdioPipe }>({
  pipe: async ({}, use) => {
    const pipe = new StdioPipe();
    await use(pipe);
    await pipe.close();
  },
});

describe("BandMcpStdioServer", () => {
  it("advertises the configured capabilities and instructions alongside the tools", async ({ pipe }) => {
    const server = await pipe.startServer({ capabilities: { experimental: EXPERIMENTAL }, instructions: INSTRUCTIONS });
    const client = await pipe.connectClient();

    expect(client.getServerCapabilities()).toMatchObject({ experimental: EXPERIMENTAL, tools: {} });
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
    expect(await pipe.listedToolNames()).toEqual(server.toolNames);
  });

  it("keeps the default handshake and tools without the new options", async ({ pipe }) => {
    const server = await pipe.startServer();
    const client = await pipe.connectClient();

    expect(client.getInstructions()).toBeUndefined();
    expect(client.getServerCapabilities()?.experimental).toBeUndefined();
    expect(server.toolNames).not.toHaveLength(0);
    expect(await pipe.listedToolNames()).toEqual(server.toolNames);
  });

  it("delivers a custom notification to the client", async ({ pipe }) => {
    const server = await pipe.startServer();
    await pipe.connectClient();
    const received = pipe.nextNotification();

    await server.notify(METHOD, PARAMS);

    expect((await received).notification).toEqual(NOTIFICATION);
  });

  it("holds a notification until the client has initialized", async ({ pipe }) => {
    const server = await pipe.startServer();
    const received = pipe.nextNotification();

    const sent = server.notify(METHOD, PARAMS);
    await pipe.connectClient();
    await sent;

    expect(await received).toEqual({ notification: NOTIFICATION, afterHandshake: true });
  });

  it("settles a pending notify when the server stops", async ({ pipe }) => {
    const server = await pipe.startServer();

    const sent = server.notify(METHOD, PARAMS);
    await server.stop();

    await expect(sent).rejects.toThrow(NOT_RUNNING);
  });

  it.for(["endInput", "closeOutput"] as const)(
    "stops when the client goes away (%s)",
    async (loseClient, { pipe }) => {
      const server = await pipe.startServer();
      await pipe.connectClient();

      await pipe[loseClient]();

      await expect(server.notify(METHOD, PARAMS)).rejects.toThrow(NOT_RUNNING);
    },
  );

  it("stops when the transport closes itself", async ({ pipe }) => {
    const server = await pipe.startServer();
    const sent = server.notify(METHOD, PARAMS);

    pipe.sendOversizedLine();

    await expect(sent).rejects.toThrow(NOT_RUNNING);
  });

  // An unhandled EPIPE after the stop would fail this run.
  it("survives a queued write failing after the client has gone", async ({ pipe }) => {
    const server = await pipe.startServer();
    await pipe.connectClient();
    const outputFailed = pipe.breakOutput();

    const sent = server.notify(METHOD, PARAMS);
    await pipe.endInput();
    await Promise.allSettled([sent, outputFailed]);

    await expect(server.notify(METHOD)).rejects.toThrow(NOT_RUNNING);
  });

  it("rejects notify before start and after stop", async ({ pipe }) => {
    const server = pipe.createServer();
    await expect(server.notify(METHOD)).rejects.toThrow(NOT_RUNNING);

    await server.start();
    await server.stop();
    await expect(server.notify(METHOD)).rejects.toThrow(NOT_RUNNING);
  });
});
