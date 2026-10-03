import { once } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Notification } from "@modelcontextprotocol/sdk/types.js";

import { BandMcpStdioServer, type BandMcpStdioServerOptions } from "../src/mcp/stdio";
import { FakeTools } from "./testUtils";

const METHOD = "notifications/x";
const PARAMS = { content: "hi", meta: { room_id: "r1" } };
const EXPERIMENTAL = { "test/ext": {} };
const INSTRUCTIONS = "Reply through the tools.";

type StartedServer = ReturnType<typeof createServerIn>;

function createServerIn(cleanups: Array<() => Promise<void>>, options: Partial<BandMcpStdioServerOptions> = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const server = new BandMcpStdioServer({ tools: new FakeTools(), stdin, stdout, ...options });
  cleanups.push(() => server.stop());
  return { server, stdin, stdout };
}

function newClient(): Client {
  return new Client({ name: "test-client", version: "1.0.0" });
}

function nextNotification(client: Client): Promise<Notification> {
  return new Promise((resolve) => {
    client.fallbackNotificationHandler = async (notification) => resolve(notification);
  });
}

describe("BandMcpStdioServer", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  const createServer = (options?: Partial<BandMcpStdioServerOptions>) => createServerIn(cleanups, options);

  // The SDK's stdio transport takes any stream pair, so it also serves as the client end of the pipe.
  async function connect({ stdin, stdout }: StartedServer, client = newClient()): Promise<Client> {
    await client.connect(new StdioServerTransport(stdout, stdin));
    cleanups.push(() => client.close());
    return client;
  }

  async function startConnected(options?: Partial<BandMcpStdioServerOptions>) {
    const started = createServer(options);
    await started.server.start();
    return { ...started, client: await connect(started) };
  }

  it("advertises the configured capabilities and instructions alongside the tools", async () => {
    const { server, client } = await startConnected({
      capabilities: { experimental: EXPERIMENTAL },
      instructions: INSTRUCTIONS,
    });

    expect(client.getServerCapabilities()?.experimental).toEqual(EXPERIMENTAL);
    expect(client.getServerCapabilities()?.tools).toBeDefined();
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(server.toolNames);
  });

  it("delivers a custom notification to the client", async () => {
    const { server, client } = await startConnected();
    const received = nextNotification(client);

    await server.notify(METHOD, PARAMS);

    expect(await received).toEqual({ jsonrpc: "2.0", method: METHOD, params: PARAMS });
  });

  it("holds a notification until the client has initialized", async () => {
    const started = createServer();
    await started.server.start();

    const sent = started.server.notify(METHOD, PARAMS);
    const client = newClient();
    const handshakeDoneOnArrival = new Promise<boolean>((resolve) => {
      client.fallbackNotificationHandler = async () => resolve(client.getServerCapabilities() !== undefined);
    });
    await connect(started, client);
    await sent;

    expect(await handshakeDoneOnArrival).toBe(true);
  });

  it("settles a pending notify when the server stops", async () => {
    const { server } = createServer();
    await server.start();

    const sent = server.notify(METHOD, PARAMS);
    await server.stop();

    await expect(sent).rejects.toThrow("not running");
  });

  it.each([
    ["stdin ends", (started: StartedServer) => {
      started.stdin.end();
      return once(started.stdin, "end");
    }],
    ["stdout closes", (started: StartedServer) => {
      started.stdout.destroy();
      return once(started.stdout, "close");
    }],
  ])("stops when the client goes away (%s)", async (_case, loseClient) => {
    const started = await startConnected();

    await loseClient(started);

    await expect(started.server.notify(METHOD, PARAMS)).rejects.toThrow("not running");
  });

  it("rejects notify before start and after stop", async () => {
    const { server } = createServer();
    await expect(server.notify(METHOD)).rejects.toThrow("not running");

    await server.start();
    await server.stop();
    await expect(server.notify(METHOD)).rejects.toThrow("not running");
  });

  it("keeps the default handshake and tools without the new options", async () => {
    const { server, client } = await startConnected();

    expect(client.getInstructions()).toBeUndefined();
    expect(client.getServerCapabilities()?.experimental).toBeUndefined();
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.map((tool) => tool.name)).toEqual(server.toolNames);
  });
});
