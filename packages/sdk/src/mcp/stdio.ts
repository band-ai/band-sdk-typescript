import type { Readable, Writable } from "node:stream";

import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";

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
  stdin?: Readable;
  stdout?: Writable;
  capabilities?: ServerCapabilities;
  instructions?: string;
}

export class BandMcpStdioServer {
  private readonly options: BandMcpStdioServerOptions;
  private readonly registrations: McpToolRegistration[];
  private mcpServer: InstanceType<typeof import("@modelcontextprotocol/sdk/server/mcp.js").McpServer> | null = null;
  private transport: import("@modelcontextprotocol/sdk/server/stdio.js").StdioServerTransport | null = null;

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
    if (this.transport) {
      return;
    }

    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const { z } = await import("zod");

    const mcpServer = new McpServer(
      {
        name: this.options.name ?? MCP_SERVER_NAME,
        version: "1.0.0",
      },
      {
        capabilities: this.options.capabilities,
        instructions: this.options.instructions,
      },
    );

    registerTools(mcpServer, z, this.registrations);

    const transport = new StdioServerTransport(this.options.stdin, this.options.stdout);
    await mcpServer.connect(transport);

    this.mcpServer = mcpServer;
    this.transport = transport;
  }

  public async stop(): Promise<void> {
    await this.transport?.close();
    this.transport = null;
    this.mcpServer = null;
  }

  /**
   * Push a server-initiated notification (e.g. `notifications/claude/channel`)
   * to the connected client. Requires `start()` to have already run.
   */
  public async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    if (!this.mcpServer) {
      throw new Error("BandMcpStdioServer.notify called before start()");
    }
    await this.mcpServer.server.notification({ method, params });
  }
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
