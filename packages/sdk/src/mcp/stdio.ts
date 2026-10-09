import type { Readable, Writable } from "node:stream";

import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ElicitRequestFormParams,
  ElicitRequestURLParams,
  ElicitResult,
  ReadResourceResult,
  Resource,
  ResourceListChangedNotification,
  ToolListChangedNotification,
} from "@modelcontextprotocol/sdk/types.js";

import type { AdapterToolsProtocol } from "../contracts/protocols";
import type {
  BuildRegistrationsOptions,
  McpToolRegistration,
} from "./registrations";
import {
  buildRoomScopedRegistrations,
  buildSingleContextRegistrations,
  registerTools,
} from "./registrations";
import { ToolsListedTransport } from "./toolsListedTransport";
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from "../contracts/toolSchemas";

/** A host's resources under one URI template; a variable that may hold `/` needs the `{+name}` form. */
export interface McpResourceSource {
  name: string;
  uriTemplate: string;
  /** Called on every `resources/list`, so it always shows the host's current set. */
  list(): Resource[] | Promise<Resource[]>;
  /** Called for any URI matching the template, listed or not, so it throws for one it doesn't know. */
  read(uri: URL): ReadResourceResult | Promise<ReadResourceResult>;
}

export interface BandMcpStdioServerOptions {
  /** Without it, the server lists only `additionalTools`. */
  tools?: AdapterToolsProtocol | ((roomId: string) => AdapterToolsProtocol | undefined);
  name?: string;
  enableMemoryTools?: boolean;
  enableTaskTools?: boolean;
  enableContactTools?: boolean;
  additionalTools?: McpToolRegistration[];
  /** With a `tools` resolver, what the tools outside `ROOM_TOOL_NAMES` run on, registered without `room_id`. */
  roomlessTools?: AdapterToolsProtocol;
  capabilities?: import("@modelcontextprotocol/sdk/types.js").ServerCapabilities;
  instructions?: string;
  resources?: McpResourceSource;
  stdin?: Readable;
  stdout?: Writable;
}

export class BandMcpStdioServer {
  private readonly options: BandMcpStdioServerOptions;
  private readonly registrations: McpToolRegistration[];
  private session: StdioSession | null = null;

  public constructor(options: BandMcpStdioServerOptions) {
    this.options = options;

    const regOptions: BuildRegistrationsOptions = {
      enableMemoryTools: options.enableMemoryTools,
      enableTaskTools: options.enableTaskTools,
      enableContactTools: options.enableContactTools,
      additionalTools: options.additionalTools,
      roomlessTools: options.roomlessTools,
    };

    if (!options.tools) {
      this.registrations = [...(options.additionalTools ?? [])];
    } else if (typeof options.tools === "function") {
      this.registrations = buildRoomScopedRegistrations(options.tools, regOptions);
    } else {
      this.registrations = buildSingleContextRegistrations(options.tools, regOptions);
    }
  }

  /** The running session's tools; before `start()`, the initial ones. */
  public get toolNames(): string[] {
    return this.session ? [...this.session.tools.keys()] : this.registrations.map((r) => r.name);
  }

  public async start(): Promise<void> {
    if (this.session) {
      return;
    }

    const [mcp, stdio, { z }] = await Promise.all([
      import("@modelcontextprotocol/sdk/server/mcp.js"),
      import("@modelcontextprotocol/sdk/server/stdio.js"),
      import("zod"),
    ]);
    const modules: McpModules = { ...mcp, ...stdio, z };
    const stdin = this.options.stdin ?? process.stdin;
    const stdout = this.options.stdout ?? process.stdout;
    const session = openSession(modules, this.options, this.registrations, stdin, stdout, () => {
      if (this.session === session) {
        void this.stop();
      }
    });
    this.session = session;
    await session.connect();
  }

  /** Sends once the client has initialized; rejects if the server stops first. */
  public notify(method: string, params?: Record<string, unknown>): Promise<void> {
    return this.whenRunning((session) => session.mcpServer.server.notification({ method, params }));
  }

  /** Registers the batch, sending one `tools/list_changed`; a name already registered rejects the whole batch. */
  public addTools(registrations: McpToolRegistration[]): Promise<void> {
    return this.whenRunning((session) => session.register(registrations));
  }

  /**
   * Removes the named tools, sending one `tools/list_changed`. It acts on the tools added so far,
   * so await `addTools` first; unknown names, and calls when not running, are ignored.
   */
  public removeTools(names: string[]): void {
    const tools = this.session?.tools;
    for (const name of names) {
      tools?.get(name)?.remove();
      tools?.delete(name);
    }
  }

  /** Tells the client the `resources` source's set changed. */
  public resourcesChanged(): Promise<void> {
    return this.whenRunning((session) => session.mcpServer.server.sendResourceListChanged());
  }

  /** Throws for a client without the elicitation mode; pass a `timeout`, since the default is 60 s. */
  public elicitInput(
    params: ElicitRequestFormParams | ElicitRequestURLParams,
    options?: RequestOptions,
  ): Promise<ElicitResult> {
    return this.whenRunning((session) => session.mcpServer.server.elicitInput(params, options));
  }

  /** Resolves once the response to the client's first `tools/list` is sent; rejects if the server stops first. Read it after `await start()`. */
  public get toolsListed(): Promise<void> {
    return this.whenRunning((session) => session.toolsListed);
  }

  /** Resolves once the client has initialized; rejects if the server stops first. Read it after `await start()`. */
  public get initialized(): Promise<void> {
    return this.whenRunning(() => undefined);
  }

  /** Resolves once the server is not running: after stop(), or once the client went away. Read it after `await start()`. */
  public get stopped(): Promise<void> {
    return this.session?.stopped ?? Promise.resolve();
  }

  public async stop(): Promise<void> {
    const session = this.session;
    this.session = null;
    await session?.close();
  }

  /** Runs `work` once the client has initialized; rejects before `start()`, after `stop()`, or if the server stops first. */
  private async whenRunning<T>(work: (session: StdioSession) => T | Promise<T>): Promise<T> {
    const session = this.session;
    if (!session) {
      throw notRunning();
    }
    return session.untilStopped(session.initialized.then(() => work(session)));
  }
}

type McpModules = typeof import("@modelcontextprotocol/sdk/server/mcp.js")
  & typeof import("@modelcontextprotocol/sdk/server/stdio.js")
  & { z: typeof import("zod").z };

// Each tool added or removed sends one; debouncing folds a batch into a single notification.
const LIST_CHANGED_NOTIFICATIONS: Array<ToolListChangedNotification["method"] | ResourceListChangedNotification["method"]> = [
  "notifications/tools/list_changed",
  "notifications/resources/list_changed",
];
const PLACEHOLDER_TOOL = "band_placeholder";

interface StdioSession {
  mcpServer: McpServer;
  /** The tools listed now, by name. */
  tools: Map<string, RegisteredTool>;
  toolsListed: Promise<void>;
  register(registrations: McpToolRegistration[]): void;
  connect(): Promise<void>;
  // MCP allows no server requests before the client's `notifications/initialized`, so the gate waits for it.
  initialized: Promise<void>;
  stopped: Promise<void>;
  // Settles pending sends: the stdio transport never fails a write to a dead pipe.
  untilStopped<T>(work: Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function notRunning(): Error {
  return new Error("BandMcpStdioServer is not running");
}

function ignoreLateWriteError(): void {}

// The SDK's stdio transport ignores stdin end and stdout errors, so the session
// watches them itself; otherwise a send after the client exits crashes on EPIPE or hangs.
function openSession(
  modules: McpModules,
  options: BandMcpStdioServerOptions,
  registrations: McpToolRegistration[],
  stdin: Readable,
  stdout: Writable,
  onClientGone: () => void,
): StdioSession {
  const { mcpServer, tools, register } = buildMcpServer(modules, options, registrations);
  const transport = new ToolsListedTransport(new modules.StdioServerTransport(stdin, stdout));

  const initialized = new Promise<void>((resolve) => {
    mcpServer.server.oninitialized = resolve;
  });
  // The transport also closes itself, e.g. on an oversized line.
  mcpServer.server.onclose = onClientGone;
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  // Each wait leaves the set once settled, so a long session holds nothing per send.
  const pendingRejects = new Set<(error: Error) => void>();

  const clientGoneEvents: Array<[Readable | Writable, string]> = [
    [stdin, "end"],
    [stdin, "close"],
    [stdout, "close"],
  ];
  for (const [stream, event] of clientGoneEvents) {
    stream.on(event, onClientGone);
  }
  // Keep one handler without session state for writes that fail after teardown.
  if (!stdout.listeners("error").includes(ignoreLateWriteError)) {
    stdout.on("error", ignoreLateWriteError);
  }
  stdout.on("error", onClientGone);

  return {
    mcpServer,
    tools,
    toolsListed: transport.toolsListed,
    register,
    connect: () => mcpServer.connect(transport),
    initialized,
    stopped,
    untilStopped(work) {
      return new Promise((resolve, reject) => {
        pendingRejects.add(reject);
        void work.then(resolve, reject).finally(() => pendingRejects.delete(reject));
      });
    },
    async close() {
      for (const [stream, event] of clientGoneEvents) {
        stream.off(event, onClientGone);
      }
      stdout.off("error", onClientGone);
      // First, so a caller racing `stopped` sees the client leave before the failures that causes.
      resolveStopped();
      for (const reject of pendingRejects) {
        reject(notRunning());
      }
      await mcpServer.close();
    },
  };
}

/** The session's MCP server: its tools, the placeholder that installs the tools handlers, and the resource template. */
function buildMcpServer(
  modules: McpModules,
  options: BandMcpStdioServerOptions,
  registrations: McpToolRegistration[],
): Pick<StdioSession, "mcpServer" | "tools" | "register"> {
  const mcpServer = new modules.McpServer(
    { name: options.name ?? MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      capabilities: options.capabilities,
      instructions: options.instructions,
      debouncedNotificationMethods: LIST_CHANGED_NOTIFICATIONS,
    },
  );
  const tools = new Map<string, RegisteredTool>();
  const register = (batch: McpToolRegistration[]) => {
    for (const [name, tool] of registerTools(mcpServer, modules.z, batch)) {
      tools.set(name, tool);
    }
  };
  register(registrations);
  // The tools handlers and `tools.listChanged` come with the first tool and can't be added after connect.
  if (tools.size === 0) {
    mcpServer.registerTool(PLACEHOLDER_TOOL, {}, () => ({ content: [] })).remove();
  }
  const { resources } = options;
  if (resources) {
    // Empty metadata: the template's would be copied onto every listed resource.
    const template = new modules.ResourceTemplate(resources.uriTemplate, {
      list: async () => ({ resources: await resources.list() }),
    });
    mcpServer.registerResource(resources.name, template, {}, (uri) => resources.read(uri));
  }

  return { mcpServer, tools, register };
}
