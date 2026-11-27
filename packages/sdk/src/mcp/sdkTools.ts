import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { mcpToolNames, MCP_SERVER_NAME } from "../contracts/toolSchemas";
import type { McpToolRegistration } from "./registrations";
import { buildZodShape } from "./zod";
import { AdmissionTransport, type OriginResolver } from "./admission";
import type { Logger } from "../core/logger";

export interface SdkMcpBridgeOptions {
  /** Custom tools registered with a loose schema, so the original schema validates every business argument. */
  portableRegistrations?: McpToolRegistration[];
  /** Without one the bridge serves no operation ids. */
  originResolver?: OriginResolver;
  logger?: Logger;
}

export function createSdkMcpBridge(
  registrations: McpToolRegistration[],
  { portableRegistrations = [], originResolver, logger }: SdkMcpBridgeOptions = {},
) {
  const nativeDefinitions = registrations.map(toSdkToolDefinition);
  const portableDefinitions = portableRegistrations.map(toSdkToolDefinition);
  const serverConfig = createSdkMcpServer({ name: MCP_SERVER_NAME, tools: nativeDefinitions });
  // The harness connects this instance to its own in-process transport; the
  // SDK-owned decorator stands between that transport and the framework's
  // dispatch, exactly as on the network bridges. Without a resolver the
  // bridge serves no operation ids, and a keyed call is refused rather than
  // posted without its key.
  serverConfig.instance = withAdmission(serverConfig.instance, originResolver, logger);
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

/**
 * `instance` with its `connect` standing behind the admission decorator: the
 * harness's transport is wrapped before it reaches the framework, and every
 * other member of the real instance behaves exactly as it does unwrapped.
 */
function withAdmission<T extends { connect(transport: unknown): Promise<void> }>(
  instance: T,
  originResolver: OriginResolver | undefined,
  logger: Logger | undefined,
): T {
  return new Proxy(instance, {
    get(target, property, receiver) {
      if (property === "connect") {
        return (transport: unknown) =>
          Reflect.get(target, "connect", target).call(target, new AdmissionTransport(transport as ConstructorParameters<typeof AdmissionTransport>[0], originResolver, logger));
      }
      return Reflect.get(target, property, receiver);
    },
  });
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
