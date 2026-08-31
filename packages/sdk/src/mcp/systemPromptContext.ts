import type { AgentIdentity } from "../client/rest/types";
import type { AdapterToolsProtocol } from "../contracts/protocols";
import { asErrorMessage } from "../core/errors";

/** Resolves the tool surface for a room, or `undefined` when the room is not tracked. */
type GetToolsForRoom = (roomId: string) => AdapterToolsProtocol | undefined;

/** Room context an MCP client can drop into a system prompt, as data and as markdown. */
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

/** Per-call overrides for how long a built room context stays cached. */
export interface GetSystemPromptContextOptions {
  ttlMs?: number;
}

interface CacheEntry {
  value: GetSystemPromptContextResult;
  expiresAt: number;
  lastAccessedAt: number;
}

const DEFAULT_TTL_MS = 30_000;
const MAX_CONTEXT_CACHE_ENTRIES = 100;

/**
 * Builds a room's system-prompt context and caches it per room.
 *
 * Building the context costs at least one participant fetch and, for the room title, a
 * paged chat listing, so repeat calls within the TTL are served from memory. The cache is
 * bounded and evicts least-recently-used entries.
 */
export class SystemPromptContextCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly getToolsForRoom: GetToolsForRoom;
  private readonly maxEntries: number;

  public constructor(getToolsForRoom: GetToolsForRoom, maxEntries = MAX_CONTEXT_CACHE_ENTRIES) {
    this.getToolsForRoom = getToolsForRoom;
    this.maxEntries = maxEntries;
  }

  public async get(
    roomId: string,
    options?: GetSystemPromptContextOptions,
  ): Promise<GetSystemPromptContextResult> {
    const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    const now = Date.now();
    const cached = this.entries.get(roomId);
    if (cached && cached.expiresAt > now) {
      cached.lastAccessedAt = now;
      return cached.value;
    }
    if (cached) {
      this.entries.delete(roomId);
    }

    const tools = this.getToolsForRoom(roomId);
    if (!tools) {
      return buildUnavailableSystemPromptContext(roomId);
    }

    const context = await buildSystemPromptContext(roomId, tools);
    this.entries.set(roomId, {
      value: context,
      expiresAt: now + ttlMs,
      lastAccessedAt: now,
    });
    this.evictLeastRecentlyUsed();
    return context;
  }

  private evictLeastRecentlyUsed(): void {
    if (this.entries.size <= this.maxEntries) {
      return;
    }

    let oldestKey: string | null = null;
    let oldestAccessedAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.entries.entries()) {
      if (entry.lastAccessedAt < oldestAccessedAt) {
        oldestAccessedAt = entry.lastAccessedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.entries.delete(oldestKey);
    }
  }
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
  //
  // The cast stays local on purpose: widening AdapterToolsProtocol would put an optional
  // REST surface on the contract every adapter has to satisfy, for the benefit of one
  // best-effort lookup that already degrades to a warning.
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
      warning: `Unable to resolve agent identity: ${asErrorMessage(error)}`,
    };
  }

  return { value: null, warning: null };
}

async function resolveRoomTitle(
  tools: AdapterToolsProtocol,
  roomId: string,
): Promise<{ value: string | null; warning: string | null }> {
  // Duck-typed for the same reason as resolveAgentIdentity above.
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
      warning: `Unable to resolve room title: ${asErrorMessage(error)}`,
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

function normalizeHandle(handle: string | null | undefined): string | null {
  return typeof handle === "string" && handle.trim().length > 0 ? handle.trim() : null;
}
