import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AdapterToolsProtocol } from "../contracts/protocols";
import { DeliveryUnknownError, isDeliveryUnknownOutput } from "../core/deliveryFailedError";
import { UnsupportedFeatureError } from "../core/errors";
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
  toolInputProperties,
  getToolDescription,
  ROOM_ID_ARG,
} from "../contracts/toolSchemas";
import { buildZodShape } from "./zod";
import { buildOriginResolver, currentAdmission, roomIdOf, type OriginResolver } from "./admission";

export { ROOM_ID_ARG };

export interface McpToolRegistration {
  name: string;
  description: string;
  inputSchema: McpToolInputSchema;
  /** Passed to the client in `tools/list`, e.g. `anthropic/alwaysLoad`. */
  _meta?: Record<string, unknown>;
  /**
   * `tools` is the tools of the room the call belongs to, or undefined on a
   * server built without any. They carry the room's full authority (sending,
   * participants, contacts, memory), whatever tools the server itself enables.
   *
   * On a room-scoped server, a tool receives them only by declaring `room_id`,
   * and keeps them only while the server's room resolver still returns that
   * same instance, so a resolver must return one instance per room turn.
   */
  execute: (
    args: Record<string, unknown>,
    tools?: AdapterToolsProtocol,
    /** Aborts when the host withdraws the call (e.g. OMP `host_tool_cancel`). */
    signal?: AbortSignal,
  ) => Promise<McpToolResult>;
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
  /** @internal Wraps execution without changing tool schemas or results. */
  execute?: (work: () => Promise<McpToolResult>) => Promise<McpToolResult>;
  enableMemoryTools?: boolean;
  enableTaskTools?: boolean;
  enableContactTools?: boolean;
  /**
   * Advertise the optional `operation_id` on `band_send_message` and
   * `band_no_reply`. Enable it only when every room the tools resolve to
   * journals its replies and posts through the single-attempt transport;
   * elsewhere a keyed call is refused.
   */
  enableOperationIds?: boolean;
  additionalTools?: McpToolRegistration[];
  /**
   * What room-scoped registrations run the tools outside `ROOM_TOOL_NAMES` on;
   * with it, those tools register without `room_id`.
   */
  roomlessTools?: AdapterToolsProtocol;
}

type ToolResolver = (roomId: string) => AdapterToolsProtocol | undefined;

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
export function scopeToRoom<T extends AdapterToolsProtocol>(
  tool: McpToolSchema,
  resolver: (roomId: string) => T | undefined,
  execute: (tools: T, args: Record<string, unknown>) => Promise<McpToolResult>,
): McpToolRegistration {
  return {
    ...tool,
    inputSchema: withRoomId(tool.inputSchema),
    execute: ({ [ROOM_ID_ARG]: roomIdArg, ...args }) =>
      dispatchKeyed(
        roomIdArg,
        (admitted) => execute(admitted as T, args),
        () => inRoom(roomIdArg, resolver, (roomTools) => execute(roomTools, args)),
      ),
  };
}

/** The refusal a keyed call earns for naming a room other than the one it was admitted in. */
function wrongRoomResult(roomIdArg: unknown, admittedRoomId: string): string {
  return `The call's ${ROOM_ID_ARG} ${JSON.stringify(roomIdArg)} names a different room than the one its operation was admitted in (${admittedRoomId}); it is refused rather than rerouted`;
}

/**
 * Runs a call: a keyed one on the tools its admission pinned, never on
 * whatever the room resolves to now, and refused with what its admission
 * recorded or when it names another room; an unkeyed one through `unkeyed`.
 */
function dispatchKeyed(
  roomIdArg: unknown,
  admitted: (tools: AdapterToolsProtocol) => Promise<McpToolResult>,
  unkeyed: () => Promise<McpToolResult>,
): Promise<McpToolResult> {
  const admission = currentAdmission();
  if (admission === undefined) {
    return unkeyed();
  }
  if (admission.refusal !== undefined) {
    return Promise.resolve(errorResult(admission.refusal));
  }
  const { origin } = admission;
  if (origin.roomId !== undefined && roomIdOf(roomIdArg) !== origin.roomId) {
    return Promise.resolve(errorResult(wrongRoomResult(roomIdArg, origin.roomId)));
  }
  return admitted(origin.tools);
}

/** Whether a tool's input properties declare {@link ROOM_ID_ARG}. */
export function declaresRoomId(properties: Record<string, unknown>): boolean {
  return Object.hasOwn(properties, ROOM_ID_ARG);
}

/** `schema` with a required {@link ROOM_ID_ARG}, as every room-scoped call needs one. */
function withRoomId({ properties, required }: McpToolInputSchema): McpToolInputSchema {
  return {
    type: "object",
    properties: { ...properties, [ROOM_ID_ARG]: ROOM_ID_PROPERTY },
    required: [...required.filter((name) => name !== ROOM_ID_ARG), ROOM_ID_ARG],
  };
}

/** Runs `run` with the tools of the room `roomIdArg` names, refusing a call that names no known room. */
async function inRoom<T extends AdapterToolsProtocol>(
  roomIdArg: unknown,
  resolver: (roomId: string) => T | undefined,
  run: (tools: T, roomId: string) => Promise<McpToolResult>,
): Promise<McpToolResult> {
  const roomId = roomIdOf(roomIdArg);
  if (!roomId) {
    return errorResult(`Missing required ${ROOM_ID_ARG}`);
  }
  const tools = resolver(roomId);
  if (!tools) {
    return errorResult(noToolContext(roomId));
  }
  return run(tools, roomId);
}

function noToolContext(roomId: string): string {
  return `No tool context found for ${ROOM_ID_ARG} ${roomId}`;
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
  const registrations = toolSchemas(resolveToolNames(options), options.enableOperationIds ?? false).map((tool) =>
    roomlessTools && !ROOM_TOOL_NAMES.has(tool.name)
      ? bindTool(tool, roomlessTools)
      : scopeToRoom(tool, resolver, (tools, args) => executeToolCall(tools, tool.name, args)));

  if (options.additionalTools) {
    registrations.push(...scopeHostTools(options.additionalTools, resolver));
  }

  return wrapExecution(registrations, options.execute);
}

/**
 * Host tools for a room-scoped server: one that declares {@link ROOM_ID_ARG}
 * has it advertised as required and runs with the tools of the room its call
 * names, for as long as `resolver` still returns those same tools (see
 * {@link McpToolRegistration.execute}); a call naming no known room is refused
 * without running it. One that declares none still runs, with tools that throw
 * a clear error on use, since its call cannot say which room it means.
 */
export function scopeHostTools(hostTools: McpToolRegistration[], resolver: ToolResolver): McpToolRegistration[] {
  return hostTools.map((tool) => {
    if (!declaresRoomId(tool.inputSchema.properties)) {
      return bindHostTool(tool, roomlessHostTools(tool.name));
    }
    return {
      ...tool,
      inputSchema: withRoomId(tool.inputSchema),
      execute: (args: Record<string, unknown>, _tools?: AdapterToolsProtocol, signal?: AbortSignal) =>
        dispatchKeyed(
          args[ROOM_ID_ARG],
          (admitted) => tool.execute(args, admitted, signal),
          () => inRoom(args[ROOM_ID_ARG], resolver, (tools, roomId) => tool.execute(args, whileCurrent(roomId, tools, resolver), signal)),
        ),
    };
  });
}

/** Host tools for a single-room server, each run with that room's `tools`. */
export function bindHostTools(hostTools: McpToolRegistration[], tools: AdapterToolsProtocol): McpToolRegistration[] {
  return hostTools.map((tool) => bindHostTool(tool, tools));
}

function bindHostTool(tool: McpToolRegistration, tools: AdapterToolsProtocol): McpToolRegistration {
  return {
    ...tool,
    execute: (args, _tools, signal) => {
      const run = (runTools: AdapterToolsProtocol) => tool.execute(args, runTools, signal);
      return dispatchKeyed(args[ROOM_ID_ARG], run, () => run(tools));
    },
  };
}

// A host tool can outlive its turn, so each property access checks that the
// room still resolves to the tools the call began with: gone, or replaced by a
// newer turn's, they are refused rather than acting on the room.
function whileCurrent(roomId: string, tools: AdapterToolsProtocol, resolver: ToolResolver): AdapterToolsProtocol {
  return forwardTools(() => {
    if (resolver(roomId) !== tools) {
      throw new UnsupportedFeatureError(`${noToolContext(roomId)}: the call's tools are no longer current`);
    }
    return tools;
  });
}

// Symbol keys and `then` read as absent, so awaiting or inspecting the value
// does not throw; any other use names the fix.
function roomlessHostTools(toolName: string): AdapterToolsProtocol {
  return new Proxy({} as AdapterToolsProtocol, {
    get(_target, key) {
      if (typeof key === "symbol" || key === "then") {
        return undefined;
      }
      throw new UnsupportedFeatureError(
        `Host tool '${toolName}' runs on a room-scoped MCP server: declare ${ROOM_ID_ARG} in its inputSchema to receive the room's tools`,
      );
    },
  });
}

/**
 * Build MCP tool registrations for a single tools instance (no room_id needed).
 */
export function buildSingleContextRegistrations(
  tools: AdapterToolsProtocol,
  options: BuildRegistrationsOptions = {},
): McpToolRegistration[] {
  const registrations = toolSchemas(resolveToolNames(options), options.enableOperationIds ?? false).map((tool) => bindTool(tool, tools));

  if (options.additionalTools) {
    registrations.push(...bindHostTools(options.additionalTools, tools));
  }

  return wrapExecution(registrations, options.execute);
}

/** What a bridge needs to stand: its registrations, and the origin its keyed calls admit through. */
export interface BridgeRegistrations {
  registrations: McpToolRegistration[];
  /** Absent unless the bridge serves operation ids: its keyed calls are then refused at admission. */
  originResolver: OriginResolver | undefined;
}

/**
 * The registrations and origin resolver of a bridge over `tools`: room-scoped
 * for a resolver with `multiRoom`, else single-context. Admission and dispatch
 * agree on what is served: only a bridge built with `enableOperationIds`
 * resolves origins, consulting `admissionGuard` first.
 */
export function buildBridgeRegistrations(
  tools: AdapterToolsProtocol | ToolResolver,
  multiRoom: boolean,
  options: BuildRegistrationsOptions & { admissionGuard?: () => boolean },
): BridgeRegistrations {
  const { admissionGuard, ...registrationOptions } = options;
  const roomScoped = typeof tools === "function" && multiRoom;
  const registrations = roomScoped
    ? buildRoomScopedRegistrations(tools, registrationOptions)
    : buildSingleContextRegistrations(typeof tools === "function" ? resolveSingleRoomTools(tools) : tools, registrationOptions);
  const resolver: ToolResolver = typeof tools === "function" ? tools : () => tools;
  return {
    registrations,
    originResolver: options.enableOperationIds ? buildOriginResolver(resolver, roomScoped, admissionGuard) : undefined,
  };
}

function wrapExecution(registrations: McpToolRegistration[], execute?: BuildRegistrationsOptions["execute"]): McpToolRegistration[] {
  return execute ? registrations.map((registration) => ({
    ...registration, execute: (args, tools, signal) => execute(() => registration.execute(args, tools, signal)),
  })) : registrations;
}

function bindTool(tool: McpToolSchema, tools: AdapterToolsProtocol): McpToolRegistration {
  return {
    ...tool,
    execute: (args) => {
      const run = (runTools: AdapterToolsProtocol) => executeToolCall(runTools, tool.name, args);
      return dispatchKeyed(args[ROOM_ID_ARG], run, () => run(tools));
    },
  };
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

function toolSchemas(toolNames: Set<string>, operationIds: boolean): McpToolSchema[] {
  const schemas: McpToolSchema[] = [];
  for (const toolName of toolNames) {
    const model = TOOL_MODELS[toolName as keyof typeof TOOL_MODELS];
    if (model) {
      schemas.push({
        name: toolName,
        description: getToolDescription(toolName),
        inputSchema: { type: "object", properties: { ...toolInputProperties(toolName, model.properties, operationIds) }, required: [...model.required] },
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
      // A classified delivery-unknown keeps its classification across the MCP
      // boundary: the result says the delivery is unknown and Band may
      // already hold it — nothing to call a plain tool failure, and no
      // adapter text or recovery advice is carried with it. A keyed
      // operation's unknown stands under the operation's own text.
      if (isDeliveryUnknownOutput(result)) {
        return unknownDeliveryResult(result.details.keyed === true ? result.message : undefined);
      }
      return errorResult(toLegacyToolExecutorErrorMessage(result) ?? result.message);
    }
    return successResult(result);
  } catch (error) {
    if (error instanceof DeliveryUnknownError) {
      return unknownDeliveryResult(error.keyed ? error.message : undefined);
    }
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

/**
 * The MCP result for a delivery that stands unknown: the stable sanitized
 * `delivery_unknown` discriminator, and the one guidance a caller can act on
 * safely — do not resend. A keyed operation's unknown carries the operation's
 * own text; a reply's keeps the generic post text. No adapter text, no
 * status, no cause: the delivery may already stand in the room, and a resend
 * could post it twice. Callers that need more than the discriminator get it
 * from the SDK, not from this result.
 */
function unknownDeliveryResult(operationDetail?: string): McpToolResult {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        kind: DeliveryUnknownError.KIND,
        detail: operationDetail ?? "The post's delivery is unknown: Band may already hold it. Do not resend it.",
      }),
    }],
    isError: true,
  };
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
