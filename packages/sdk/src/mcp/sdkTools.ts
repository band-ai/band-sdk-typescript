import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { mcpToolNames, MCP_SERVER_NAME } from "../contracts/toolSchemas";
import type { McpToolRegistration } from "./registrations";
import { buildZodShape } from "./zod";

export function createSdkMcpBridge(registrations: McpToolRegistration[]) {
  const toolDefinitions = registrations.map(toSdkToolDefinition);
  return {
    serverConfig: createSdkMcpServer({ name: MCP_SERVER_NAME, tools: toolDefinitions }),
    allowedTools: mcpToolNames(new Set(registrations.map((registration) => registration.name))),
    toolDefinitions,
  };
}

function toSdkToolDefinition(registration: McpToolRegistration): SdkMcpToolDefinition {
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
