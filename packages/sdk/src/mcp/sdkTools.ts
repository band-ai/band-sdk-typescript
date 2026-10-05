import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { mcpToolNames, MCP_SERVER_NAME } from "../contracts/toolSchemas";
import type { McpToolRegistration } from "./registrations";
import { buildZodShape } from "./zod";

export function createSdkMcpBridge(
  registrations: McpToolRegistration[],
  portableRegistrations: McpToolRegistration[] = [],
) {
  const nativeDefinitions = registrations.map(toSdkToolDefinition);
  const portableDefinitions = portableRegistrations.map(toSdkToolDefinition);
  const serverConfig = createSdkMcpServer({ name: MCP_SERVER_NAME, tools: nativeDefinitions });
  for (const definition of portableDefinitions) {
    // Preserve all business arguments for the original custom-tool schema to validate.
    serverConfig.instance.registerTool(definition.name, {
      description: definition.description,
      inputSchema: z.looseObject(definition.inputSchema),
    }, definition.handler);
  }
  const toolDefinitions = [...nativeDefinitions, ...portableDefinitions];
  return {
    serverConfig,
    allowedTools: mcpToolNames(new Set(toolDefinitions.map((definition) => definition.name))),
    toolDefinitions,
  };
}

function toSdkToolDefinition(registration: McpToolRegistration) {
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
