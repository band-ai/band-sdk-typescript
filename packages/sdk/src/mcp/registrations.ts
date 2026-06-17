import type { AdapterToolsProtocol } from "../contracts/protocols";
import {
  isToolExecutorError,
  toLegacyToolExecutorErrorMessage,
} from "../contracts/protocols";
import {
  BASE_TOOL_NAMES,
  CONTACT_TOOL_NAMES,
  MEMORY_TOOL_NAMES,
  TOOL_MODELS,
  getToolDescription,
} from "../runtime/tools/schemas";

export interface McpToolRegistration {
  name: string;
  description: string;
  inputSchema: McpToolInputSchema;
  execute: (args: Record<string, unknown>) => Promise<McpToolResult>;
}

export interface McpToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
}

export interface McpToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
}

export interface BuildRegistrationsOptions {
  enableMemoryTools?: boolean;
  enableContactTools?: boolean;
  additionalTools?: McpToolRegistration[];
}

type ToolResolver = (roomId: string) => AdapterToolsProtocol | undefined;

/**
 * Build MCP tool registrations with room-scoped tool resolution.
 * Each tool call requires a `room_id` argument to look up the correct tools instance.
 */
export function buildRoomScopedRegistrations(
  resolver: ToolResolver,
  options: BuildRegistrationsOptions = {},
): McpToolRegistration[] {
  const toolNames = resolveToolNames(options);
  const registrations = buildRegistrations(toolNames, async (toolName, args) => {
    const roomId = asNonEmptyString(args.room_id);
    if (!roomId) {
      return errorResult("Missing required room_id");
    }

    const tools = resolver(roomId);
    if (!tools) {
      return errorResult(`No tool context found for room_id ${roomId}`);
    }

    const toolArgs = { ...args };
    delete toolArgs.room_id;
    return executeToolCall(tools, toolName, toolArgs);
  }, { injectRoomId: true });

  if (options.additionalTools) {
    registrations.push(...options.additionalTools);
  }

  return registrations;
}

/**
 * Build MCP tool registrations for a single tools instance (no room_id needed).
 */
export function buildSingleContextRegistrations(
  tools: AdapterToolsProtocol,
  options: BuildRegistrationsOptions = {},
): McpToolRegistration[] {
  const toolNames = resolveToolNames(options);
  const registrations = buildRegistrations(toolNames, (_toolName, args) => {
    return executeToolCall(tools, _toolName, args);
  }, { injectRoomId: false });

  if (options.additionalTools) {
    registrations.push(...options.additionalTools);
  }

  return registrations;
}

function resolveToolNames(options: BuildRegistrationsOptions): Set<string> {
  const names = new Set<string>();
  for (const name of BASE_TOOL_NAMES) {
    if (!options.enableContactTools && CONTACT_TOOL_NAMES.has(name)) {
      continue;
    }
    names.add(name);
  }
  if (options.enableMemoryTools) {
    for (const name of MEMORY_TOOL_NAMES) {
      names.add(name);
    }
  }
  return names;
}

function buildRegistrations(
  toolNames: Set<string>,
  executor: (toolName: string, args: Record<string, unknown>) => Promise<McpToolResult>,
  opts: { injectRoomId: boolean },
): McpToolRegistration[] {
  const registrations: McpToolRegistration[] = [];

  for (const toolName of toolNames) {
    const model = TOOL_MODELS[toolName as keyof typeof TOOL_MODELS];
    if (!model) {
      continue;
    }

    const properties: Record<string, unknown> = { ...model.properties };
    const required: string[] = [...model.required];

    if (opts.injectRoomId) {
      properties.room_id = { type: "string", description: "The room ID to execute this tool in" };
      required.push("room_id");
    }

    registrations.push({
      name: toolName,
      description: getToolDescription(toolName),
      inputSchema: {
        type: "object",
        properties,
        required,
      },
      execute: (args) => executor(toolName, args),
    });
  }

  return registrations;
}

async function executeToolCall(
  tools: AdapterToolsProtocol,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  try {
    const result = await tools.executeToolCall(toolName, args);
    if (isToolExecutorError(result)) {
      return errorResult(toLegacyToolExecutorErrorMessage(result) ?? result.message);
    }
    return successResult(result);
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function successResult(value: unknown): McpToolResult {
  return {
    content: [{
      type: "text",
      text: serializeValue(value),
    }],
  };
}

export function errorResult(message: string): McpToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function serializeValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? json : String(value);
  } catch {
    return String(value);
  }
}

/**
 * Resolves the single tools instance for single-room mode. Calls `getToolsForRoom("")`
 * as the sentinel — callers in single-room mode must return their tools instance
 * regardless of the room ID argument.
 */
export function resolveSingleRoomTools(
  getToolsForRoom: (roomId: string) => AdapterToolsProtocol | undefined,
): AdapterToolsProtocol {
  const tools = getToolsForRoom("");
  if (!tools) {
    throw new Error("Single-room mode requires getToolsForRoom(\"\") to return a tools instance");
  }
  return tools;
}
