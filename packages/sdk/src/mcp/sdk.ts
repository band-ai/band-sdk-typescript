import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { AgentIdentity } from "../client/rest/types";
import type { AdapterToolsProtocol } from "../contracts/protocols";
import { mcpToolNames } from "../runtime/tools/schemas";
import {
  buildRoomScopedRegistrations,
  buildSingleContextRegistrations,
  resolveSingleRoomTools,
  type McpToolRegistration,
} from "./registrations";
import { buildZodShape } from "./zod";

export interface CreateThenvoiSdkMcpServerOptions {
  enableMemoryTools: boolean;
  /**
   * Returns the tools for a given room. In single-room mode (`multiRoom: false`),
   * called once during init with `""` — must return the tools instance regardless of the argument.
   */
  getToolsForRoom: (roomId: string) => AdapterToolsProtocol | undefined;
  additionalTools?: McpToolRegistration[];
  multiRoom?: boolean;
}

export interface GetSystemPromptContextResult {
  roomId: string;
  roomTitle: string | null;
  agent: {
    id: string;
    name: string;
    handle: string | null;
    description: string | null;
  };
  participants: Array<{
    id: string;
    name: string;
    type: string;
    handle: string | null;
    isSelf: boolean;
  }>;
  mentionFormat: string;
  warnings: string[];
  markdown: string;
}

export interface GetSystemPromptContextOptions {
  ttlMs?: number;
}

export interface ThenvoiSdkMcpServer {
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

export function createThenvoiSdkMcpServer(
  options: CreateThenvoiSdkMcpServerOptions,
): ThenvoiSdkMcpServer {
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
  const contextCache = new Map<string, { value: GetSystemPromptContextResult; expiresAt: number; lastAccessedAt: number }>();
  const MAX_CONTEXT_CACHE_ENTRIES = 100;

  const serverConfig = createSdkMcpServer({
    name: "thenvoi",
    tools: toolDefinitions,
  });

  return {
    serverConfig,
    allowedTools: mcpToolNames(toolNames),
    toolDefinitions,
    getSystemPromptContext: async (roomId, contextOptions) => {
      const context = await getOrBuildSystemPromptContext(
        roomId,
        contextOptions,
        options.getToolsForRoom,
        contextCache,
        MAX_CONTEXT_CACHE_ENTRIES,
      );
      return context.markdown;
    },
    getSystemPromptContextData: (roomId, contextOptions) => {
      return getOrBuildSystemPromptContext(
        roomId,
        contextOptions,
        options.getToolsForRoom,
        contextCache,
        MAX_CONTEXT_CACHE_ENTRIES,
      );
    },
  };
}

async function getOrBuildSystemPromptContext(
  roomId: string,
  contextOptions: GetSystemPromptContextOptions | undefined,
  getToolsForRoom: (roomId: string) => AdapterToolsProtocol | undefined,
  contextCache: Map<string, { value: GetSystemPromptContextResult; expiresAt: number; lastAccessedAt: number }>,
  maxEntries: number,
): Promise<GetSystemPromptContextResult> {
  const ttlMs = contextOptions?.ttlMs ?? 30_000;
  const now = Date.now();
  const cached = contextCache.get(roomId);
  if (cached && cached.expiresAt > now) {
    cached.lastAccessedAt = now;
    return cached.value;
  }
  if (cached) {
    contextCache.delete(roomId);
  }

  const tools = getToolsForRoom(roomId);
  if (!tools) {
    return buildUnavailableSystemPromptContext(roomId);
  }

  const context = await buildSystemPromptContext(roomId, tools);
  contextCache.set(roomId, {
    value: context,
    expiresAt: now + ttlMs,
    lastAccessedAt: now,
  });
  evictLeastRecentlyUsedContext(contextCache, maxEntries);
  return context;
}

async function buildSystemPromptContext(
  roomId: string,
  tools: AdapterToolsProtocol,
): Promise<GetSystemPromptContextResult> {
  const participants = await tools.getParticipants();
  const warnings: string[] = [];
  const agentResolution = await resolveAgentIdentity(tools);
  if (agentResolution.warning) {
    warnings.push(agentResolution.warning);
  }
  const roomResolution = await resolveRoomTitle(tools, roomId);
  if (roomResolution.warning) {
    warnings.push(roomResolution.warning);
  }
  const agentIdentity = agentResolution.value;
  const roomTitle = roomResolution.value;
  const normalizedParticipants = participants.map((participant) => ({
    id: String(participant.id),
    name: String(participant.name ?? "Unknown"),
    type: String(participant.type ?? "Unknown"),
    handle: normalizeHandle(participant.handle),
    isSelf: participant.id === agentIdentity?.id,
  }));
  const selfHandle = normalizeHandle(agentIdentity?.handle);
  const selfName = agentIdentity?.name ?? "Agent";
  const mentionHandles = normalizedParticipants
    .filter((participant) => !participant.isSelf)
    .map((participant) => participant.handle)
    .filter((handle): handle is string => Boolean(handle));
  const mentionFormat = mentionHandles.length > 0 ? mentionHandles.join(", ") : "No participant handles available";
  const roomLabel = roomTitle ? `\"${roomTitle}\"` : "this room";
  const agentLabel = selfHandle ? `${selfName} (${selfHandle})` : selfName;
  const participantLines = normalizedParticipants.length > 0
    ? normalizedParticipants.map((participant) => {
        const suffix = participant.isSelf ? " (you)" : "";
        const handle = participant.handle ? ` (${participant.handle})` : "";
        return `- **${participant.name}**${handle} -- ${participant.type}${suffix}`;
      }).join("\n")
    : "- No participants found";

  const markdown = [
    "## Room Context",
    "",
    `You are **${agentLabel}** in room ${roomLabel} (id: ${roomId}).`,
    "",
    "### Participants",
    participantLines,
    "",
    "### Mention Format",
    `To address someone, use their exact handle: ${mentionFormat}`,
    ...(warnings.length > 0 ? ["", "### Warnings", ...warnings.map((warning) => `- ${warning}`)] : []),
  ].join("\n");

  return {
    roomId,
    roomTitle,
    agent: {
      id: agentIdentity?.id ?? "unknown-agent",
      name: selfName,
      handle: selfHandle,
      description: agentIdentity?.description ?? null,
    },
    participants: normalizedParticipants,
    mentionFormat,
    warnings,
    markdown,
  };
}

async function resolveAgentIdentity(
  tools: AdapterToolsProtocol,
): Promise<{ value: AgentIdentity | null; warning: string | null }> {
  // AdapterToolsProtocol doesn't surface agent identity directly. We duck-type two
  // known extension points: a dedicated `getAgentIdentity()` method (future-facing) and
  // `rest.getAgentMe()` which concrete adapters (e.g. FernRestAdapter) expose.
  const maybeTools = tools as AdapterToolsProtocol & {
    getAgentIdentity?: () => Promise<AgentIdentity>;
    rest?: { getAgentMe?: () => Promise<AgentIdentity> };
  };

  try {
    if (maybeTools.getAgentIdentity) {
      return { value: await maybeTools.getAgentIdentity(), warning: null };
    }

    if (maybeTools.rest?.getAgentMe) {
      return { value: await maybeTools.rest.getAgentMe(), warning: null };
    }
  } catch (error) {
    return {
      value: null,
      warning: `Unable to resolve agent identity: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return { value: null, warning: null };
}

async function resolveRoomTitle(
  tools: AdapterToolsProtocol,
  roomId: string,
): Promise<{ value: string | null; warning: string | null }> {
  const maybeTools = tools as AdapterToolsProtocol & {
    rest?: {
      listChats?: (request: { page: number; pageSize: number }) => Promise<{ data?: Array<Record<string, unknown>>; metadata?: { totalPages?: number } }>;
    };
  };

  const rest = maybeTools.rest;
  if (!rest?.listChats) {
    return { value: null, warning: null };
  }

  try {
    let page = 1;
    const pageSize = 100;

    while (true) {
      const response = await rest.listChats({ page, pageSize });
      const room = response?.data?.find((entry) => entry.id === roomId);
      if (typeof room?.title === "string" && room.title.length > 0) {
        return { value: room.title, warning: null };
      }

      const totalPages = response?.metadata?.totalPages ?? page;
      if (page >= totalPages) {
        return { value: null, warning: null };
      }

      page += 1;
    }
  } catch (error) {
    return {
      value: null,
      warning: `Unable to resolve room title: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function buildUnavailableSystemPromptContext(roomId: string): GetSystemPromptContextResult {
  const warnings = [`No tool context found for room_id ${roomId}`];
  const markdown = [
    "## Room Context",
    "",
    `You are **Agent** in this room (id: ${roomId}).`,
    "",
    "### Participants",
    "- No participants found",
    "",
    "### Mention Format",
    "No participant handles available",
    "",
    "### Warnings",
    ...warnings.map((warning) => `- ${warning}`),
  ].join("\n");

  return {
    roomId,
    roomTitle: null,
    agent: {
      id: "unknown-agent",
      name: "Agent",
      handle: null,
      description: null,
    },
    participants: [],
    mentionFormat: "No participant handles available",
    warnings,
    markdown,
  };
}

function evictLeastRecentlyUsedContext(
  contextCache: Map<string, { value: GetSystemPromptContextResult; expiresAt: number; lastAccessedAt: number }>,
  maxEntries: number,
): void {
  if (contextCache.size <= maxEntries) {
    return;
  }

  let oldestKey: string | null = null;
  let oldestAccessedAt = Number.POSITIVE_INFINITY;
  for (const [key, entry] of contextCache.entries()) {
    if (entry.lastAccessedAt < oldestAccessedAt) {
      oldestAccessedAt = entry.lastAccessedAt;
      oldestKey = key;
    }
  }

  if (oldestKey) {
    contextCache.delete(oldestKey);
  }
}

function normalizeHandle(handle: string | null | undefined): string | null {
  return typeof handle === "string" && handle.trim().length > 0 ? handle.trim() : null;
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
