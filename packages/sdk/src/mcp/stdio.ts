import type { Readable, Writable } from "node:stream";

import type { AdapterToolsProtocol } from "../contracts/protocols";
import type {
  BuildRegistrationsOptions,
  McpToolRegistration,
} from "./registrations";
import {
  buildRoomScopedRegistrations,
  buildSingleContextRegistrations,
} from "./registrations";
import { buildZodShape } from "./zod";
import { MCP_SERVER_NAME } from "../runtime/tools/schemas";

export interface BandMcpStdioServerOptions {
  tools: AdapterToolsProtocol | ((roomId: string) => AdapterToolsProtocol | undefined);
  name?: string;
  enableMemoryTools?: boolean;
  enableContactTools?: boolean;
  additionalTools?: McpToolRegistration[];
  capabilities?: import("@modelcontextprotocol/sdk/types.js").ServerCapabilities;
  instructions?: string;
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
      enableContactTools: options.enableContactTools,
      additionalTools: options.additionalTools,
    };

    if (typeof options.tools === "function") {
      this.registrations = buildRoomScopedRegistrations(options.tools, regOptions);
    } else {
      this.registrations = buildSingleContextRegistrations(options.tools, regOptions);
    }
  }

  public get toolNames(): string[] {
    return this.registrations.map((r) => r.name);
  }

  public async start(): Promise<void> {
    if (this.session) {
      return;
    }

    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const { z } = await import("zod");

    const mcpServer = new McpServer(
      { name: this.options.name ?? MCP_SERVER_NAME, version: "1.0.0" },
      { capabilities: this.options.capabilities, instructions: this.options.instructions },
    );

    registerTools(mcpServer, z, this.registrations);

    const stdin = this.options.stdin ?? process.stdin;
    const stdout = this.options.stdout ?? process.stdout;
    const session = openSession(mcpServer, stdin, stdout, () => void this.stop());
    await mcpServer.connect(new StdioServerTransport(stdin, stdout));

    this.session = session;
  }

  /** Sends once the client has initialized; rejects if the server stops first. */
  public async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    const session = this.session;
    if (!session) {
      throw notRunning();
    }
    await Promise.race([
      session.initialized.then(() => session.mcpServer.server.notification({ method, params })),
      session.stopped,
    ]);
  }

  public async stop(): Promise<void> {
    const session = this.session;
    this.session = null;
    await session?.close();
  }
}

type McpServerInstance = InstanceType<typeof import("@modelcontextprotocol/sdk/server/mcp.js").McpServer>;

interface StdioSession {
  mcpServer: McpServerInstance;
  // MCP allows no server-initiated messages before the client's `notifications/initialized`.
  initialized: Promise<void>;
  // Settles pending sends: the stdio transport never fails a write to a dead pipe.
  stopped: Promise<never>;
  close(): Promise<void>;
}

function notRunning(): Error {
  return new Error("BandMcpStdioServer is not running");
}

// The SDK's stdio transport ignores stdin end and stdout errors, so the session
// watches them itself; otherwise a send after the client exits crashes on EPIPE or hangs.
function openSession(
  mcpServer: McpServerInstance,
  stdin: Readable,
  stdout: Writable,
  onClientGone: () => void,
): StdioSession {
  const initialized = new Promise<void>((resolve) => {
    mcpServer.server.oninitialized = resolve;
  });
  let rejectStopped!: (error: Error) => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectStopped = reject;
  });
  stopped.catch(() => undefined);

  stdin.on("end", onClientGone).on("close", onClientGone);
  stdout.on("error", onClientGone).on("close", onClientGone);

  return {
    mcpServer,
    initialized,
    stopped,
    async close() {
      stdin.off("end", onClientGone).off("close", onClientGone);
      stdout.off("error", onClientGone).off("close", onClientGone);
      rejectStopped(notRunning());
      await mcpServer.close();
    },
  };
}

function registerTools(
  mcpServer: InstanceType<typeof import("@modelcontextprotocol/sdk/server/mcp.js").McpServer>,
  z: typeof import("zod").z,
  registrations: McpToolRegistration[],
): void {
  for (const reg of registrations) {
    const zodShape = buildZodShape(z, reg.inputSchema.properties, new Set(reg.inputSchema.required));

    mcpServer.registerTool(
      reg.name,
      {
        description: reg.description,
        inputSchema: z.object(zodShape),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MCP SDK handler signature is complex; our McpToolResult is compatible
      async (args: Record<string, unknown>): Promise<any> => reg.execute(args),
    );
  }
}
