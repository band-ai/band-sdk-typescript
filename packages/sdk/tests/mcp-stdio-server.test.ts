import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { Client, type ClientOptions } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/sdk/shared/stdio.js";
import {
  ElicitRequestSchema,
  LATEST_PROTOCOL_VERSION,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
  type ElicitRequestFormParams,
  type Notification,
  type Resource,
} from "@modelcontextprotocol/sdk/types.js";

import { successResult, type McpToolRegistration } from "../src/mcp/registrations";
import { BandMcpStdioServer, type BandMcpStdioServerOptions, type McpResourceSource } from "../src/mcp/stdio";
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

function newClient(options?: ClientOptions): Client {
  return new Client({ name: "test-client", version: "1.0.0" }, options);
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

type InProcessOptions = Omit<BandMcpStdioServerOptions, "stdin" | "stdout">;

const it = test.extend<{
  startPlugin: (script: string, payloadBytes?: number) => PluginProcess;
  connect: (options?: InProcessOptions, clientOptions?: ClientOptions) => Promise<{ server: BandMcpStdioServer; client: Client }>;
}>({
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
  /** A started in-process server with a connected client, both closed when the test ends. */
  connect: async ({}, use) => {
    const open: Array<{ server: BandMcpStdioServer; client: Client }> = [];
    await use(async (options, clientOptions) => {
      const { server, connectClient } = inProcessServer(options);
      await server.start();
      const session = { server, client: await connectClient(clientOptions) };
      open.push(session);
      return session;
    });
    await Promise.all(open.flatMap(({ server, client }) => [client.close(), server.stop()]));
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

function inProcessServer(options: InProcessOptions = { tools: new FakeTools() }) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const server = new BandMcpStdioServer({ ...options, stdin, stdout });
  const connectClient = async (clientOptions?: ClientOptions) => {
    const client = newClient(clientOptions);
    await client.connect(new StdioServerTransport(stdout, stdin));
    return client;
  };
  return { server, stdin, stdout, connectClient };
}

describe("BandMcpStdioServer lifecycle", () => {
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

  test("resolves initialized on the client's initialized notification, not its initialize request", async () => {
    const { server, stdin, stdout } = inProcessServer();
    await server.start();
    let initialized = false;
    void server.initialized.then(() => {
      initialized = true;
    });
    const send = (message: Record<string, unknown>) => stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

    const initializeResult = once(stdout, "data");
    send({ id: 1, method: "initialize", params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test-client", version: "1.0.0" } } });
    await initializeResult;
    expect(initialized).toBe(false);

    send({ method: "notifications/initialized" });
    await server.initialized;
    await server.stop();
  });

  test("rejects initialized when the server stops before the client initializes", async () => {
    const { server } = inProcessServer();
    await server.start();

    const initialized = server.initialized;
    await server.stop();

    await expect(initialized).rejects.toThrow(NOT_RUNNING);
  });

  test("settles a pending notify when the server stops", async () => {
    const { server } = inProcessServer();
    await server.start();

    const sent = server.notify(PUSH_METHOD);
    await server.stop();

    await expect(sent).rejects.toThrow(NOT_RUNNING);
  });

  test("restarting on the same pipe releases old sessions and tolerates late write errors", async () => {
    const { server, stdout } = inProcessServer();
    await server.start();
    await server.stop();
    const retainedListeners = stdout.listenerCount("error");

    for (let restart = 0; restart < 3; restart++) {
      await server.start();
      const initialized = expect(server.initialized).rejects.toThrow(NOT_RUNNING);
      const sent = expect(server.notify(PUSH_METHOD)).rejects.toThrow(NOT_RUNNING);
      await server.stop();
      await Promise.all([initialized, sent]);
    }

    expect(stdout.listenerCount("error")).toBe(retainedListeners);
    // A write queued before teardown can fail after the session's listeners are released.
    expect(() => stdout.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }))).not.toThrow();
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

const ALWAYS_LOAD = { "anthropic/alwaysLoad": true };
const FORM_ELICITATION: ClientOptions = { capabilities: { elicitation: { form: {} } } };
const AGENT_QUESTION: ElicitRequestFormParams = {
  message: "Which agent?",
  requestedSchema: { type: "object", properties: { agent: { type: "string" } }, required: ["agent"] },
};
const AGENT_ANSWER = { action: "accept", content: { agent: "acme/qa" } } as const;

function echoTool(name: string, _meta?: Record<string, unknown>): McpToolRegistration {
  return {
    name,
    description: `Answers with ${name}`,
    inputSchema: { type: "object", properties: {}, required: [] },
    execute: async () => successResult(name),
    _meta,
  };
}

/** Counts a client's notifications of one kind; `next()` resolves on the following one. */
function listenFor(
  client: Client,
  schema: typeof ToolListChangedNotificationSchema | typeof ResourceListChangedNotificationSchema,
) {
  const waiting: Array<() => void> = [];
  const received = { count: 0, next: () => new Promise<void>((resolve) => waiting.push(resolve)) };
  client.setNotificationHandler(schema, () => {
    received.count++;
    for (const resolve of waiting.splice(0)) {
      resolve();
    }
  });
  return received;
}

async function toolNamesListed(client: Client): Promise<string[]> {
  const { tools } = await client.listTools();
  return tools.map((tool) => tool.name);
}

/** The agents a host offers as resources, under a template whose handle may hold `/`. */
class AgentResources implements McpResourceSource {
  public readonly name = "agents";
  public readonly uriTemplate = "band://agent/{+handle}";
  public handles: string[];

  public constructor(handles: string[]) {
    this.handles = handles;
  }

  public list(): Resource[] {
    return this.handles.map((handle) => ({ uri: this.uri(handle), name: handle }));
  }

  public read(uri: URL) {
    const handle = this.handles.find((known) => this.uri(known) === uri.href);
    if (!handle) {
      throw new Error(`Unknown agent ${uri.href}`);
    }
    return { contents: [{ uri: uri.href, text: `Agent ${handle}` }] };
  }

  private uri(handle: string): string {
    return `band://agent/${handle}`;
  }
}

describe("BandMcpStdioServer tools and resources", () => {
  it("lists a tool's _meta as registered", async ({ connect }) => {
    const { client } = await connect({ tools: new FakeTools(), additionalTools: [echoTool("reply", ALWAYS_LOAD)] });

    const { tools } = await client.listTools();

    expect(tools.find((tool) => tool.name === "reply")?._meta).toEqual(ALWAYS_LOAD);
  });

  it("without tools, lists only the additional tools", async ({ connect }) => {
    const { client } = await connect({ additionalTools: [echoTool("reply"), echoTool("send")] });

    expect(await toolNamesListed(client)).toEqual(["reply", "send"]);
  });

  it("with no tools at all, lists none and declares tools.listChanged", async ({ connect }) => {
    const { client } = await connect({});

    expect(client.getServerCapabilities()?.tools).toEqual({ listChanged: true });
    expect(await toolNamesListed(client)).toEqual([]);
  });

  it("started empty, adds a batch of tools and removes them, one list_changed each", async ({ connect }) => {
    const { server, client } = await connect({});
    const toolsChanged = listenFor(client, ToolListChangedNotificationSchema);

    const added = toolsChanged.next();
    await server.addTools([echoTool("reply"), echoTool("send"), echoTool("open_room")]);
    await added;
    expect(await toolNamesListed(client)).toEqual(["reply", "send", "open_room"]);
    expect(toolsChanged.count).toBe(1);
    expect(await client.callTool({ name: "send", arguments: {} })).toMatchObject({ content: [{ type: "text", text: "send" }] });

    const removed = toolsChanged.next();
    server.removeTools(["reply", "send", "open_room", "never_added"]);
    await removed;
    expect(await toolNamesListed(client)).toEqual([]);
    expect(toolsChanged.count).toBe(2);
  });

  it("a batch holding a listed name registers none of it", async ({ connect }) => {
    const { server, client } = await connect({ additionalTools: [echoTool("reply")] });

    await expect(server.addTools([echoTool("send"), echoTool("reply")])).rejects.toThrow("reply");
    await expect(server.addTools([echoTool("send"), echoTool("send")])).rejects.toThrow("send");

    expect(await toolNamesListed(client)).toEqual(["reply"]);
  });

  test("rejects addTools before start", async () => {
    const { server } = inProcessServer({});

    await expect(server.addTools([echoTool("reply")])).rejects.toThrow(NOT_RUNNING);
  });

  it("lists the source's current resources, announces a change, and reads a handle with a slash", async ({ connect }) => {
    const agents = new AgentResources(["acme/qa"]);
    const { server, client } = await connect({ resources: agents });
    const resourcesChanged = listenFor(client, ResourceListChangedNotificationSchema);

    expect((await client.listResources()).resources.map((resource) => resource.uri)).toEqual(["band://agent/acme/qa"]);

    agents.handles = ["acme/qa", "acme/dev"];
    const changed = resourcesChanged.next();
    await server.resourcesChanged();
    await changed;
    expect((await client.listResources()).resources.map((resource) => resource.uri)).toEqual(["band://agent/acme/qa", "band://agent/acme/dev"]);

    const { contents } = await client.readResource({ uri: "band://agent/acme/qa" });
    expect(contents).toEqual([{ uri: "band://agent/acme/qa", text: "Agent acme/qa" }]);
  });

  it("settles toolsListed after the client's first tools/list, then elicits an answer", async ({ connect }) => {
    const { server, client } = await connect({}, FORM_ELICITATION);
    const asked: unknown[] = [];
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      asked.push(request.params);
      return AGENT_ANSWER;
    });
    let listed = false;
    const toolsListed = server.toolsListed.then(() => {
      listed = true;
    });

    await server.initialized;
    await client.ping();
    expect(listed).toBe(false);

    await client.listTools();
    await toolsListed;

    expect(await server.elicitInput(AGENT_QUESTION)).toEqual(AGENT_ANSWER);
    expect(asked).toEqual([{ mode: "form", ...AGENT_QUESTION }]);
  });

  it("rejects elicitInput for a client without form elicitation, and after stop", async ({ connect }) => {
    const { server } = await connect({});

    await expect(server.elicitInput(AGENT_QUESTION)).rejects.toThrow("form elicitation");

    await server.stop();
    await expect(server.elicitInput(AGENT_QUESTION)).rejects.toThrow(NOT_RUNNING);
  });
});
