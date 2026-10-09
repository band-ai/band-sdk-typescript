import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AdapterToolsProtocol } from "../contracts/protocols";
import { forwardTools } from "../core/overrideTools";
import {
  isToolExecutorError,
  toLegacyToolExecutorErrorMessage,
} from "../contracts/protocols";
import {
  BASE_TOOL_NAMES,
  CONTACT_TOOL_NAMES,
  MEMORY_TOOL_NAMES,
  TASK_TOOL_NAMES,
  ROOM_TOOL_NAMES,
  TOOL_MODELS,
  getToolDescription,
} from "../contracts/toolSchemas";
import { buildZodShape } from "./zod";

export interface McpToolRegistration {
  name: string;
  description: string;
  inputSchema: McpToolInputSchema;
  /** Passed to the client in `tools/list`, e.g. `anthropic/alwaysLoad`. */
  _meta?: Record<string, unknown>;
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
  enableTaskTools?: boolean;
  enableContactTools?: boolean;
  additionalTools?: McpToolRegistration[];
  /**
   * What room-scoped registrations run the tools outside `ROOM_TOOL_NAMES` on;
   * with it, those tools register without `room_id`.
   */
  roomlessTools?: AdapterToolsProtocol;
}

type ToolResolver = (roomId: string) => AdapterToolsProtocol | undefined;

/** The argument a room-scoped tool takes to name the room it runs in. */
export const ROOM_ID_ARG = "room_id";
const ROOM_ID_PROPERTY = { type: "string", description: "The room ID to execute this tool in" } as const;

type McpToolSchema = Omit<McpToolRegistration, "execute">;

/**
 * Registers each tool on `mcpServer`, which the servers load with a dynamic `import()` alongside `z`.
 * All or none: if one throws, the ones before it are removed again.
 */
export function registerTools(
  mcpServer: McpServer,
  z: typeof import("zod").z,
  registrations: McpToolRegistration[],
): Map<string, RegisteredTool> {
  const registered = new Map<string, RegisteredTool>();
  try {
    for (const reg of registrations) {
      const zodShape = buildZodShape(z, reg.inputSchema.properties, new Set(reg.inputSchema.required));
      registered.set(reg.name, mcpServer.registerTool(
        reg.name,
        { description: reg.description, inputSchema: z.object(zodShape), _meta: reg._meta },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MCP SDK handler signature is complex; our McpToolResult is compatible
        async (args: Record<string, unknown>): Promise<any> => reg.execute(args),
      ));
    }
  } catch (error) {
    for (const tool of registered.values()) {
      tool.remove();
    }
    throw error;
  }
  return registered;
}

/**
 * `tool` scoped to a room: it takes a required {@link ROOM_ID_ARG}, and each
 * call runs `execute` with that room's tools and its other arguments. A call
 * naming no known room is refused without running anything.
 */
export function scopeToRoom<T>(
  tool: McpToolSchema,
  resolver: (roomId: string) => T | undefined,
  execute: (tools: T, args: Record<string, unknown>) => Promise<McpToolResult>,
): McpToolRegistration {
  const { properties, required } = tool.inputSchema;
  return {
    ...tool,
    inputSchema: { type: "object", properties: { ...properties, [ROOM_ID_ARG]: ROOM_ID_PROPERTY }, required: [...required, ROOM_ID_ARG] },
    execute: async ({ [ROOM_ID_ARG]: roomIdArg, ...args }) => {
      const roomId = asNonEmptyString(roomIdArg);
      if (!roomId) {
        return errorResult(`Missing required ${ROOM_ID_ARG}`);
      }
      const tools = resolver(roomId);
      if (!tools) {
        return errorResult(`No tool context found for ${ROOM_ID_ARG} ${roomId}`);
      }
      return execute(tools, args);
    },
  };
}

/**
 * Build MCP tool registrations with room-scoped tool resolution.
 * Each tool call requires a `room_id` argument to look up the correct tools instance.
 */
export function buildRoomScopedRegistrations(
  resolver: ToolResolver,
  options: BuildRegistrationsOptions = {},
): McpToolRegistration[] {
  const { roomlessTools } = options;
  const registrations = toolSchemas(resolveToolNames(options)).map((tool) =>
    roomlessTools && !ROOM_TOOL_NAMES.has(tool.name)
      ? bindTool(tool, roomlessTools)
      : scopeToRoom(tool, resolver, (tools, args) => executeToolCall(tools, tool.name, args)));

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
  const registrations = toolSchemas(resolveToolNames(options)).map((tool) => bindTool(tool, tools));

  if (options.additionalTools) {
    registrations.push(...options.additionalTools);
  }

  return registrations;
}

function bindTool(tool: McpToolSchema, tools: AdapterToolsProtocol): McpToolRegistration {
  return { ...tool, execute: (args) => executeToolCall(tools, tool.name, args) };
}

function resolveToolNames(options: BuildRegistrationsOptions): Set<string> {
  const names = new Set<string>();
  for (const name of BASE_TOOL_NAMES) {
    if (!options.enableContactTools && CONTACT_TOOL_NAMES.has(name)) {
      continue;
    }
    names.add(name);
  }
  if (options.enableTaskTools) {
    for (const name of TASK_TOOL_NAMES) names.add(name);
  }
  if (options.enableMemoryTools) {
    for (const name of MEMORY_TOOL_NAMES) {
      names.add(name);
    }
  }
  return names;
}

function toolSchemas(toolNames: Set<string>): McpToolSchema[] {
  const schemas: McpToolSchema[] = [];
  for (const toolName of toolNames) {
    const model = TOOL_MODELS[toolName as keyof typeof TOOL_MODELS];
    if (model) {
      schemas.push({
        name: toolName,
        description: getToolDescription(toolName),
        inputSchema: { type: "object", properties: { ...model.properties }, required: [...model.required] },
      });
    }
  }
  return schemas;
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
 * The tools for single-room mode, resolved through `getToolsForRoom("")` on
 * every access rather than once: each turn brings its own tools, and a call
 * must reach the turn in flight. Callers in single-room mode must return
 * their current tools regardless of the room ID argument.
 */
export function resolveSingleRoomTools(
  getToolsForRoom: (roomId: string) => AdapterToolsProtocol | undefined,
): AdapterToolsProtocol {
  const current = (): AdapterToolsProtocol => {
    const tools = getToolsForRoom("");
    if (!tools) {
      throw new Error("Single-room mode requires getToolsForRoom(\"\") to return a tools instance");
    }
    return tools;
  };
  return forwardTools(current);
}
