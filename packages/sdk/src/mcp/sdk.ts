import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { AdapterToolsProtocol } from "../contracts/protocols";
import { mcpToolNames, MCP_SERVER_NAME } from "../runtime/tools/schemas";
import {
  buildRoomScopedRegistrations,
  buildSingleContextRegistrations,
  resolveSingleRoomTools,
  type McpToolRegistration,
} from "./registrations";
import {
  SystemPromptContextCache,
  type GetSystemPromptContextOptions,
  type GetSystemPromptContextResult,
} from "./systemPromptContext";
import { buildZodShape } from "./zod";

// Re-exported so the ./mcp/claude subpath surface is unchanged by the move.
export type { GetSystemPromptContextOptions, GetSystemPromptContextResult };

/** Configuration for the in-process MCP server the Claude Agent SDK connects to. */
export interface CreateBandSdkMcpServerOptions {
  enableMemoryTools: boolean;
  /**
   * Returns the tools for a given room. In single-room mode (`multiRoom: false`),
   * called once during init with `""` — must return the tools instance regardless of the argument.
   */
  getToolsForRoom: (roomId: string) => AdapterToolsProtocol | undefined;
  additionalTools?: McpToolRegistration[];
  multiRoom?: boolean;
}

/** The MCP server config, its tool definitions, and the room-context helpers built with it. */
export interface BandSdkMcpServer {
  serverConfig: McpSdkServerConfigWithInstance;
  allowedTools: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches SDK's own SdkMcpToolDefinition<any> signature
  toolDefinitions: Array<SdkMcpToolDefinition<any>>;
  getSystemPromptContext(roomId: string, options?: GetSystemPromptContextOptions): Promise<string>;
  getSystemPromptContextData(
    roomId: string,
    options?: GetSystemPromptContextOptions,
  ): Promise<GetSystemPromptContextResult>;
}

/**
 * Builds an in-process MCP server exposing the Band platform tools to the Claude Agent SDK,
 * either scoped per room or bound to a single room's tool instance.
 */
export function createBandSdkMcpServer(
  options: CreateBandSdkMcpServerOptions,
): BandSdkMcpServer {
  const registrationOptions = {
    enableMemoryTools: options.enableMemoryTools,
    enableContactTools: true,
    additionalTools: options.additionalTools,
  };

  const registrations = options.multiRoom === false
    ? buildSingleContextRegistrations(resolveSingleRoomTools(options.getToolsForRoom), registrationOptions)
    : buildRoomScopedRegistrations(options.getToolsForRoom, registrationOptions);

  const toolDefinitions = registrations.map(toSdkToolDefinition);
  const toolNames = new Set(registrations.map((r) => r.name));
  const contextCache = new SystemPromptContextCache(options.getToolsForRoom);

  const serverConfig = createSdkMcpServer({
    name: MCP_SERVER_NAME,
    tools: toolDefinitions,
  });

  return {
    serverConfig,
    allowedTools: mcpToolNames(toolNames),
    toolDefinitions,
    getSystemPromptContext: async (roomId, contextOptions) => {
      const context = await contextCache.get(roomId, contextOptions);
      return context.markdown;
    },
    getSystemPromptContextData: (roomId, contextOptions) => {
      return contextCache.get(roomId, contextOptions);
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches SDK's own SdkMcpToolDefinition<any> signature
function toSdkToolDefinition(registration: McpToolRegistration): SdkMcpToolDefinition<any> {
  const shape = buildZodShape(
    z,
    registration.inputSchema.properties,
    new Set(registration.inputSchema.required),
  );

  return tool(
    registration.name,
    registration.description,
    shape,
    async (args: Record<string, unknown>) => registration.execute(args),
  );
}
