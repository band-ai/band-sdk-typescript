import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Notification } from "@modelcontextprotocol/sdk/types.js";

import { BandMcpStdioServer } from "../src/mcp/stdio";
import {
  BACKPRESSURED,
  PAYLOAD_BYTES_ENV,
  PUSH_CAPABILITY,
  PUSH_INSTRUCTIONS,
  PUSH_METHOD,
} from "./fixtures/stdioPushServer";
import { FakeTools } from "./testUtils";

const PUSH_SERVER = fileURLToPath(new URL("./fixtures/stdioPushServer.ts", import.meta.url));
const HOST = fileURLToPath(new URL("./fixtures/stdioHost.ts", import.meta.url));
const NOT_RUNNING = "not running";
// Larger than an OS pipe buffer, so one push fills it.
const PIPE_FILLING_PUSH_BYTES = 256 * 1024;

function newClient(): Client {
  return new Client({ name: "test-client", version: "1.0.0" });
}

/** The plugin process as Claude Code runs it: a child on real stdio pipes. */
class PluginProcess {
  public readonly client = newClient();
  private readonly child: ChildProcessWithoutNullStreams;
  private stderr = "";

  public constructor(script: string, payloadBytes = 0) {
    this.child = spawn(process.execPath, ["--import", "tsx", script], {
      env: { ...process.env, [PAYLOAD_BYTES_ENV]: String(payloadBytes) },
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
  }

  // The SDK's stdio transport takes any stream pair, so it also serves as the client end.
  // It ignores the pipes closing, so a plugin that dies first must fail the handshake here.
  public async connect(): Promise<Client> {
    const exited = once(this.child, "exit").then(([exitCode]) => {
      throw new Error(`exited ${exitCode} before the handshake: ${this.stderr}`);
    });
    await Promise.race([this.client.connect(new StdioServerTransport(this.child.stdout, this.child.stdin)), exited]);
    return this.client;
  }

  /** Registered after connect, as a real client does once it has read the capabilities. */
  public firstPush(): Promise<Notification> {
    return new Promise((resolve) => {
      this.client.fallbackNotificationHandler = async (notification) => resolve(notification);
    });
  }

  /** The client stops reading; resolves once the plugin reports a push stuck on the full pipe. */
  public async stopReadingUntilBackpressured(): Promise<void> {
    this.child.stdout.pause();
    while (!this.stderr.includes(BACKPRESSURED)) {
      await once(this.child.stderr, "data");
    }
  }

  /** Both pipe ends close, as when the client process exits. */
  public async clientExits(): Promise<{ exitCode: number | null; stderr: string }> {
    const exited = once(this.child, "exit");
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    const [exitCode] = (await exited) as [number | null];
    return { exitCode, stderr: this.stderr };
  }

  public kill(): void {
    this.child.kill();
  }
}

const it = test.extend<{ startPlugin: (script: string, payloadBytes?: number) => PluginProcess }>({
  startPlugin: async ({}, use) => {
    const started: PluginProcess[] = [];
    await use((script, payloadBytes) => {
      const plugin = new PluginProcess(script, payloadBytes);
      started.push(plugin);
      return plugin;
    });
    for (const plugin of started) {
      plugin.kill();
    }
  },
});

describe("BandMcpStdioServer as a plugin process", () => {
  it("delivers a push made before the client connected, after the handshake", async ({ startPlugin }) => {
    const plugin = startPlugin(PUSH_SERVER);
    const client = await plugin.connect();
    const push = await plugin.firstPush();

    expect(push).toMatchObject({ method: PUSH_METHOD, params: { seq: 0 } });
    expect(client.getServerCapabilities()).toMatchObject({ experimental: { [PUSH_CAPABILITY]: {} }, tools: {} });
    expect(client.getInstructions()).toBe(PUSH_INSTRUCTIONS);
    const { tools } = await client.listTools();
    expect(tools).not.toHaveLength(0);
  });

  it("exits cleanly when the client goes away while it is pushing", async ({ startPlugin }) => {
    const plugin = startPlugin(PUSH_SERVER);
    await plugin.connect();
    await plugin.firstPush();

    const { exitCode, stderr } = await plugin.clientExits();

    expect(stderr).not.toContain("EPIPE");
    expect(exitCode).toBe(0);
  });

  it("exits cleanly when the client goes away with a push stuck on a full pipe", async ({ startPlugin }) => {
    const plugin = startPlugin(PUSH_SERVER, PIPE_FILLING_PUSH_BYTES);
    await plugin.connect();
    await plugin.firstPush();
    await plugin.stopReadingUntilBackpressured();

    const { exitCode, stderr } = await plugin.clientExits();

    expect(stderr).not.toContain("EPIPE");
    expect(exitCode).toBe(0);
  });

  it("lets its host shut down once the client goes away", async ({ startPlugin }) => {
    const plugin = startPlugin(HOST);
    const client = await plugin.connect();
    await client.listTools();

    const { exitCode } = await plugin.clientExits();

    expect(exitCode).toBe(0);
  });
});

describe("BandMcpStdioServer lifecycle", () => {
  function inProcessServer() {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = new BandMcpStdioServer({ tools: new FakeTools(), stdin, stdout });
    const connectClient = async () => {
      const client = newClient();
      await client.connect(new StdioServerTransport(stdout, stdin));
      return client;
    };
    return { server, stdin, connectClient };
  }

  test("keeps the default handshake and tools without the new options", async () => {
    const { server, connectClient } = inProcessServer();
    await server.start();
    const client = await connectClient();

    expect(client.getInstructions()).toBeUndefined();
    expect(client.getServerCapabilities()?.experimental).toBeUndefined();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(server.toolNames);
    await Promise.all([client.close(), server.stop()]);
  });

  test("resolves stopped only once the host stops it", async () => {
    const { server, connectClient } = inProcessServer();
    await server.start();
    const client = await connectClient();
    let stopped = false;
    void server.stopped.then(() => {
      stopped = true;
    });

    await client.listTools();
    expect(stopped).toBe(false);

    await Promise.all([client.close(), server.stop()]);
    expect(stopped).toBe(true);
  });

  test("settles a pending notify when the server stops", async () => {
    const { server } = inProcessServer();
    await server.start();

    const sent = server.notify(PUSH_METHOD);
    await server.stop();

    await expect(sent).rejects.toThrow(NOT_RUNNING);
  });

  test("stops when the transport closes itself on an oversized line", async () => {
    const { server, stdin } = inProcessServer();
    await server.start();
    const sent = server.notify(PUSH_METHOD);

    stdin.write(Buffer.alloc(STDIO_DEFAULT_MAX_BUFFER_SIZE + 1, "a"));

    await expect(sent).rejects.toThrow(NOT_RUNNING);
  });

  test("rejects notify before start and after stop", async () => {
    const { server } = inProcessServer();
    await expect(server.notify(PUSH_METHOD)).rejects.toThrow(NOT_RUNNING);

    await server.start();
    await server.stop();
    await expect(server.notify(PUSH_METHOD)).rejects.toThrow(NOT_RUNNING);
  });
});
