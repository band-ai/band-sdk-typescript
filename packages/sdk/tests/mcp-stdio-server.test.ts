import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { Client, type ClientOptions } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/sdk/shared/stdio.js";
import {
  ElicitRequestSchema,
  LATEST_PROTOCOL_VERSION,
  type ElicitRequestFormParams,
  type ElicitResult,
  type Notification,
  type Resource,
  type Tool,
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
import { AgentTools } from "../src/runtime/tools/AgentTools";
import { PlatformRuntime } from "../src/runtime/PlatformRuntime";
import { AGENT_API_KEY, AGENT_ID, BandPlatform } from "./flows/support/bandPlatform";
import { TASK_TOOL_NAMES } from "../src/contracts/toolSchemas";
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
  serve: (options: InProcessOptions) => Promise<{ server: BandMcpStdioServer; connect: (claudeOptions?: ClaudeCodeOptions) => Promise<ClaudeCode> }>;
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
  /** A started in-process server; `connect` attaches Claude Code. Both are closed when the test ends. */
  serve: async ({}, use) => {
    const servers: BandMcpStdioServer[] = [];
    const clients: Client[] = [];
    await use(async (options) => {
      const { server, stdin, stdout } = inProcessServer(options);
      await server.start();
      servers.push(server);
      const connect = async (claudeOptions?: ClaudeCodeOptions) => {
        const claude = new ClaudeCode(claudeOptions);
        await claude.client.connect(new StdioServerTransport(stdout, stdin));
        clients.push(claude.client);
        return claude;
      };
      return { server, connect };
    });
    await Promise.all([...clients.map((client) => client.close()), ...servers.map((server) => server.stop())]);
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
  const connectClient = async () => {
    const client = newClient();
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
const AGENT_QUESTION: ElicitRequestFormParams = {
  message: "Which agent?",
  requestedSchema: { type: "object", properties: { agent: { type: "string" } }, required: ["agent"] },
};
const PICKED_AGENT = "acme/qa";
const OTHER_AGENT = "acme/dev";
const AGENT_ANSWER: ElicitResult = { action: "accept", content: { agent: PICKED_AGENT } };
const AGENT_URI_PREFIX = "band://agent/";
// The reserved form, so a handle's `/` stays in the variable.
const AGENT_URI_TEMPLATE = `${AGENT_URI_PREFIX}{+handle}`;
const UNKNOWN_AGENT = "Unknown agent";
const NEVER_ADDED = "never_added";
// What Claude Code goes through, in the order it does.
const LISTED_TOOLS = "listed tools";
const ASKED = "asked";
const TOOLS_RELISTED = "tools relisted";
const RESOURCES_RELISTED = "resources relisted";

function agentUri(handle: string): string {
  return `${AGENT_URI_PREFIX}${handle}`;
}

function agentText(handle: string): string {
  return `Agent ${handle}`;
}

function bandTool(name: string, _meta?: Record<string, unknown>): McpToolRegistration {
  return {
    name,
    description: `Answers with ${name}`,
    inputSchema: { type: "object", properties: {}, required: [] },
    execute: async () => successResult(name),
    _meta,
  };
}

/** The Band tools a host adds once an agent is picked; `reply` and `send` load up front. */
const BAND_TOOLS = [bandTool("reply", ALWAYS_LOAD), bandTool("send", ALWAYS_LOAD), bandTool("open_room")];
const BAND_TOOL_NAMES = BAND_TOOLS.map((tool) => tool.name);
const [REPLY, SEND] = BAND_TOOL_NAMES;

/** The agents a host offers Claude Code as `@` suggestions. */
class AgentDirectory implements McpResourceSource {
  public readonly name = "agents";
  public readonly uriTemplate = AGENT_URI_TEMPLATE;
  public handles: string[];

  public constructor(handles: string[]) {
    this.handles = handles;
  }

  public list(): Resource[] {
    return this.handles.map((handle) => ({ uri: agentUri(handle), name: handle }));
  }

  public read(uri: URL) {
    const handle = this.handles.find((known) => agentUri(known) === uri.href);
    if (!handle) {
      throw new Error(`${UNKNOWN_AGENT} ${uri.href}`);
    }
    return { contents: [{ uri: uri.href, text: agentText(handle) }] };
  }
}

interface ClaudeCodeOptions {
  /** Whether it declares form elicitation. */
  elicitation?: boolean;
  /** How it answers the agent question; unset, the question stays open. */
  answer?: ElicitResult;
}

/**
 * Claude Code's side of the session: a real `Client` that re-lists tools and
 * resources on each list_changed, as Claude Code does, and answers the agent question.
 */
class ClaudeCode extends EventEmitter {
  public readonly client: Client;
  public readonly events: string[] = [];
  /** The tool names Claude Code re-listed after each change, in order. */
  public readonly toolRelists: string[][] = [];

  public constructor({ elicitation = true, answer }: ClaudeCodeOptions = {}) {
    super();
    this.client = newClient({
      capabilities: elicitation ? { elicitation: { form: {} } } : {},
      // No debounce, so each re-list follows its notification without a timer.
      listChanged: {
        tools: { debounceMs: 0, onChanged: (_error, tools) => this.toolsRelisted(tools ?? []) },
        resources: { debounceMs: 0, onChanged: (_error, resources) => this.emit(RESOURCES_RELISTED, resources ?? []) },
      },
    });
    if (elicitation) {
      this.client.setRequestHandler(ElicitRequestSchema, (request) => {
        this.events.push(`${ASKED} ${request.params.message}`);
        this.emit(ASKED);
        return answer ? Promise.resolve(answer) : new Promise<never>(() => {});
      });
    }
  }

  public async listToolNames(): Promise<string[]> {
    const { tools } = await this.client.listTools();
    this.events.push(LISTED_TOOLS);
    return tools.map((tool) => tool.name);
  }

  /** The tool names after the next re-list. */
  public async nextToolNames(): Promise<string[]> {
    const [names] = (await once(this, TOOLS_RELISTED)) as [string[]];
    return names;
  }

  /** The resource names after the next re-list. */
  public async nextResourceNames(): Promise<string[]> {
    const [resources] = (await once(this, RESOURCES_RELISTED)) as [Resource[]];
    return resources.map((resource) => resource.name);
  }

  private toolsRelisted(tools: Tool[]): void {
    const names = tools.map((tool) => tool.name);
    this.toolRelists.push(names);
    this.emit(TOOLS_RELISTED, names);
  }
}

describe("BandMcpStdioServer as Claude Code's Band server", () => {
  it("asks for the agent after Claude Code's first listing, then serves the Band tools until a take-over", async ({ serve }) => {
    const agents = new AgentDirectory([PICKED_AGENT, OTHER_AGENT]);
    const { server, connect } = await serve({ resources: agents });
    const claude = await connect({ answer: AGENT_ANSWER });
    // The host asks only once Claude Code has listed its tools.
    const picked = server.toolsListed.then(() => server.elicitInput(AGENT_QUESTION));

    // Claude Code loads the `@` suggestions, looks one up, then lists the tools.
    expect((await claude.client.listResources()).resources.map((resource) => resource.name)).toEqual(agents.handles);
    const { contents } = await claude.client.readResource({ uri: agentUri(PICKED_AGENT) });
    // Spelled out: the handle's `/` must survive the template.
    expect(contents).toEqual([{ uri: "band://agent/acme/qa", text: agentText(PICKED_AGENT) }]);
    expect(await claude.listToolNames()).toEqual([]);
    expect(await picked).toEqual(AGENT_ANSWER);
    expect(claude.events).toEqual([LISTED_TOOLS, `${ASKED} ${AGENT_QUESTION.message}`]);

    const added = claude.nextToolNames();
    await server.addTools(BAND_TOOLS);
    expect(await added).toEqual(BAND_TOOL_NAMES);
    expect(server.toolNames).toEqual(BAND_TOOL_NAMES);
    const { tools } = await claude.client.listTools();
    expect(tools.map(({ name, _meta }) => ({ name, _meta }))).toEqual(BAND_TOOLS.map(({ name, _meta }) => ({ name, _meta })));
    expect(await claude.client.callTool({ name: SEND, arguments: {} })).toMatchObject({ content: [{ type: "text", text: SEND }] });

    // Another session takes the agent over, then this one picks it again.
    const removed = claude.nextToolNames();
    server.removeTools([...BAND_TOOL_NAMES, NEVER_ADDED]);
    expect(await removed).toEqual([]);
    expect(server.toolNames).toEqual([]);
    const restored = claude.nextToolNames();
    await server.addTools(BAND_TOOLS);
    expect(await restored).toEqual(BAND_TOOL_NAMES);

    // Claude Code re-listed once per change.
    expect(claude.toolRelists).toEqual([BAND_TOOL_NAMES, [], BAND_TOOL_NAMES]);
  });

  it("serves what the host did before Claude Code connected, once it has", async ({ serve }) => {
    const agents = new AgentDirectory([PICKED_AGENT]);
    const { server, connect } = await serve({ resources: agents });

    const added = server.addTools(BAND_TOOLS);
    const announced = server.resourcesChanged();
    const picked = server.elicitInput(AGENT_QUESTION);
    const claude = await connect({ answer: AGENT_ANSWER });
    const relisted = claude.nextResourceNames();

    await Promise.all([added, announced]);
    expect(await relisted).toEqual(agents.handles);
    expect(await picked).toEqual(AGENT_ANSWER);
    expect(await claude.listToolNames()).toEqual(BAND_TOOL_NAMES);
  });

  it("re-lists the agents when the host's set changes, and a stale suggestion fails to read", async ({ serve }) => {
    const agents = new AgentDirectory([PICKED_AGENT, OTHER_AGENT]);
    const { server, connect } = await serve({ resources: agents });
    const claude = await connect();

    agents.handles = [PICKED_AGENT];
    const relisted = claude.nextResourceNames();
    await server.resourcesChanged();

    expect(await relisted).toEqual(agents.handles);
    await expect(claude.client.readResource({ uri: agentUri(OTHER_AGENT) })).rejects.toThrow(UNKNOWN_AGENT);
  });

  it("without tools, lists only the host's tools", async ({ serve }) => {
    const { connect } = await serve({ additionalTools: BAND_TOOLS });
    const claude = await connect();

    expect(await claude.listToolNames()).toEqual(BAND_TOOL_NAMES);
  });

  it.for([
    ["a name already listed", [SEND, REPLY]],
    ["a name twice", [SEND, SEND]],
    ["a name the MCP SDK's registry inherits", [SEND, "toString"]],
  ] as const)("a batch with %s adds none of it", async ([_case, names], { serve }) => {
    const { server, connect } = await serve({ additionalTools: [bandTool(REPLY)] });
    const claude = await connect();

    await expect(server.addTools(names.map((name) => bandTool(name)))).rejects.toThrow(names[1]);

    expect(await claude.listToolNames()).toEqual([REPLY]);
    expect(server.toolNames).toEqual([REPLY]);
  });

  it("withdraws the agent question when the host aborts it", async ({ serve }) => {
    const { server, connect } = await serve({});
    const claude = await connect();
    const withdraw = new AbortController();

    const asking = server.elicitInput(AGENT_QUESTION, { signal: withdraw.signal });
    await once(claude, ASKED);
    withdraw.abort();

    await expect(asking).rejects.toThrow((withdraw.signal.reason as Error).message);
  });

  it("refuses the agent question for a client without form elicitation", async ({ serve }) => {
    const { server, connect } = await serve({});
    await connect({ elicitation: false });

    await expect(server.elicitInput(AGENT_QUESTION)).rejects.toThrow("form elicitation");
  });

  it("releases a host waiting on the first listing when the server stops", async ({ serve }) => {
    const { server, connect } = await serve({});
    await connect();

    const listed = server.toolsListed;
    await server.stop();

    await expect(listed).rejects.toThrow(NOT_RUNNING);
  });
});

describe("BandMcpStdioServer when not running", () => {
  const hostCalls: Array<[string, (server: BandMcpStdioServer) => Promise<unknown>]> = [
    ["addTools", (server) => server.addTools(BAND_TOOLS)],
    ["resourcesChanged", (server) => server.resourcesChanged()],
    ["elicitInput", (server) => server.elicitInput(AGENT_QUESTION)],
    ["toolsListed", (server) => server.toolsListed],
  ];

  test.each(hostCalls)("rejects %s before start and after stop", async (_name, call) => {
    const { server } = inProcessServer({ resources: new AgentDirectory([]) });
    await expect(call(server)).rejects.toThrow(NOT_RUNNING);

    await server.start();
    await server.stop();
    await expect(call(server)).rejects.toThrow(NOT_RUNNING);
  });

  test("keeps the tools it was given when the host's array changes before start", async () => {
    const hostTools = [...BAND_TOOLS];
    const { server } = inProcessServer({ additionalTools: hostTools });

    // A host that keeps its array for later `addTools` calls.
    hostTools.push(bandTool(NEVER_ADDED));

    expect(server.toolNames).toEqual(BAND_TOOL_NAMES);
  });

  test("ignores removeTools before start and after stop", async () => {
    const { server } = inProcessServer({ additionalTools: BAND_TOOLS });
    server.removeTools(BAND_TOOL_NAMES);
    expect(server.toolNames).toEqual(BAND_TOOL_NAMES);

    await server.start();
    await server.stop();
    expect(() => server.removeTools(BAND_TOOL_NAMES)).not.toThrow();
  });
});

describe("board tools over stdio", () => {
  test.each([
    { requested: true, flag: true },
    { requested: false, flag: true },
    { requested: true, flag: false },
    { requested: true, flag: undefined },
  ])("registration preserves negotiated capabilities: %j", async ({ requested, flag }) => {
    const platform = BandPlatform.host([], { featureFlags: flag === undefined ? {} : { ff_room_tasks: flag } });
    const rest = platform.rest;
    const room = await rest.createChat();
    await using runtime = new PlatformRuntime({ agentId: AGENT_ID, apiKey: AGENT_API_KEY, linkOptions: { ...platform.link, capabilities: { tasks: requested } } });
    await runtime.initialize();
    const tools = new AgentTools({ roomId: room.id, rest, capabilities: runtime.link.capabilities });
    const { server, connectClient } = inProcessServer({ tools: () => tools, enableTaskTools: true });
    await server.start();
    const client = await connectClient();
    try {
      const listed = await client.listTools();
      for (const name of TASK_TOOL_NAMES) expect(listed.tools.find((entry) => entry.name === name)?.inputSchema.required).toContain("room_id");
      const result = await client.callTool({ name: "band_create_task", arguments: { room_id: room.id, subject: "Ship board" } });
      expect(result.isError === true).toBe(!(requested && flag));
      if (!requested || !flag) {
        expect(rest.boardCalls.entries).toEqual([]);
        return;
      }
      async function call(name: string, args: Record<string, unknown> = {}) {
        const response = await client.callTool({ name, arguments: { room_id: room.id, ...args } });
        expect(response.isError).not.toBe(true);
        const [content] = response.content as { type: string; text: string }[];
        return JSON.parse(content.text);
      }
      expect(await call("band_set_board", { goal_title: "Ship" })).toMatchObject({ goal_title: "Ship" });
      expect(await call("band_get_board")).toMatchObject({ goal_title: "Ship" });
      const page = await call("band_list_tasks");
      expect(page.data).toHaveLength(1);
      expect(await call("band_get_task", { id: `#${page.data[0].number}` })).toMatchObject({ subject: "Ship board" });
      expect(await call("band_update_task", { id: page.data[0].id, status: "in_progress" })).toMatchObject({ assignments: [expect.objectContaining({ status: "in_progress" })] });
    } finally {
      await Promise.all([client.close(), server.stop()]);
    }
  });
});
