import {
  bandToolEffects,
  noReplyTool,
  type BandToolName,
  type ToolSpec,
  type TurnEffect,
} from "@band-ai/band-sdk-core";

import { CHAT_EVENT_TYPES } from "./chatEvents";
import {
  MEMORY_LIST_SCOPES,
  MEMORY_SEGMENTS,
  MEMORY_STATUSES,
  MEMORY_STORE_SCOPES,
  MEMORY_SYSTEMS,
  MEMORY_TYPES,
} from "./memory";
import type { ToolOperationResult } from "./dtos";
import type { AdapterToolMethodName } from "./protocols";

/** Canonical names for the tools with special adapter handling (reporting/reply delivery). */
export const SEND_MESSAGE_TOOL_NAME = "band_send_message";
export const SEND_EVENT_TOOL_NAME = "band_send_event";
export const NO_REPLY_TOOL_NAME = "band_no_reply";

/** `band_no_reply`'s result: it posts nothing, so there is nothing else to report. */
export const NO_REPLY_RESULT: Readonly<ToolOperationResult> = Object.freeze({ status: "ok" });

/** A core `ToolSpec` as a JSON-schema tool model; every core parameter is a string. */
function toolModelFromSpec(spec: ToolSpec) {
  return {
    description: spec.description,
    properties: Object.fromEntries(
      spec.parameters.map((parameter) => [parameter.name, { type: "string", description: parameter.description }]),
    ),
    required: spec.parameters.filter((parameter) => parameter.required).map((parameter) => parameter.name),
  };
}

export const TOOL_MODELS = {
  band_send_message: {
    description:
      "Send a message to the chat room. " +
      "Use this to respond to users or other agents. Messages require at least one @mention " +
      "in the mentions array. When the latest message needs no answer from you, " +
      `call ${NO_REPLY_TOOL_NAME} instead of sending one. When delegating, send the full task context in this message instead of assuming hidden state.`,
    properties: {
      content: {
        type: "string",
        description: "The message content to send.",
      },
      mentions: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        description:
          "List of participant handles to @mention. At least one required. " +
          "For users: @<username> (e.g., '@john'). " +
          "For agents: @<username>/<agent-name> (e.g., '@john/weather-agent'). " +
          "Use the handle of someone already in the room.",
      },
    },
    required: ["content", "mentions"],
  },
  band_send_event: {
    description:
      "Send an event to the chat room. No mentions required. " +
      "'thought': Share your reasoning or plan BEFORE taking actions. Explain what you're about to do and why. " +
      "'error': Report an error or problem that occurred. " +
      "'task': Report task progress or completion status. " +
      "Always send a thought before complex actions to keep users informed.",
    properties: {
      content: {
        type: "string",
        description: "Human-readable event content.",
      },
      message_type: {
        type: "string",
        enum: [...CHAT_EVENT_TYPES],
        description: "Type of event.",
      },
      metadata: {
        type: "object",
        description: "Optional structured data for the event.",
      },
    },
    required: ["content", "message_type"],
  },
  [NO_REPLY_TOOL_NAME]: toolModelFromSpec(noReplyTool()),
  band_add_participant: {
    description:
      "Add a participant (agent or user) to the chat room by name. " +
      "IMPORTANT: Use band_lookup_peers() first to find available agents. " +
      "Pass the exact peer name from band_lookup_peers, not the handle. " +
      "For normal delegation, omit role or use 'member'.",
    properties: {
      name: {
        type: "string",
        description:
          "Name of participant to add (must match a name from band_lookup_peers).",
      },
      role: {
        type: "string",
        enum: ["owner", "admin", "member"],
        description: "Role for the participant in this room.",
      },
    },
    required: ["name"],
  },
  band_remove_participant: {
    description: "Remove a participant from the chat room by name.",
    properties: {
      name: {
        type: "string",
        description: "Name of the participant to remove.",
      },
    },
    required: ["name"],
  },
  band_get_participants: {
    description: "Get a list of all participants in the current chat room.",
    properties: {},
    required: [],
  },
  band_lookup_peers: {
    description:
      "List available peers (agents and users) that can be added to this room. " +
      "Automatically excludes peers already in the room. " +
      "Returns dict with 'peers' list and 'metadata' (page, page_size, total_count, total_pages). " +
      "Use this to find specialized agents (e.g., Weather Agent) when you cannot answer a question directly.",
    properties: {
      page: {
        type: "integer",
        description: "Page number.",
      },
      page_size: {
        type: "integer",
        description: "Items per page (max 100).",
        maximum: 100,
      },
    },
    required: [],
  },
  band_create_chatroom: {
    description:
      "Create a new chat room for a specific task or conversation.",
    properties: {
      task_id: {
        type: "string",
        description: "Associated task ID (optional).",
      },
    },
    required: [],
  },
  band_list_contacts: {
    description: "List agent's contacts with pagination.",
    properties: {
      page: {
        type: "integer",
        description: "Page number.",
        minimum: 1,
      },
      page_size: {
        type: "integer",
        description: "Items per page.",
        minimum: 1,
        maximum: 100,
      },
    },
    required: [],
  },
  band_add_contact: {
    description:
      "Send a contact request to add someone as a contact. " +
      "Returns 'pending' when request is created. " +
      "Returns 'approved' when inverse request existed and was auto-accepted.",
    properties: {
      handle: {
        type: "string",
        description:
          "Handle of user/agent to add (e.g., '@john' or '@john/agent-name').",
      },
      message: {
        type: "string",
        description: "Optional message with the request.",
      },
    },
    required: ["handle"],
  },
  band_remove_contact: {
    description: "Remove an existing contact by handle or ID.",
    properties: {
      handle: {
        type: "string",
        description: "Contact's handle.",
      },
      contact_id: {
        type: "string",
        description: "Or contact record ID (UUID).",
      },
    },
    required: [],
  },
  band_list_contact_requests: {
    description:
      "List both received and sent contact requests. " +
      "Received requests are always filtered to pending status. " +
      "Sent requests can be filtered by status.",
    properties: {
      page: {
        type: "integer",
        description: "Page number.",
        minimum: 1,
      },
      page_size: {
        type: "integer",
        description: "Items per page per direction (max 100).",
        minimum: 1,
        maximum: 100,
      },
      sent_status: {
        type: "string",
        enum: ["pending", "approved", "rejected", "cancelled", "all"],
        description: "Filter sent requests by status.",
      },
    },
    required: [],
  },
  band_respond_contact_request: {
    description:
      "Respond to a contact request. " +
      "'approve'/'reject': For requests you RECEIVED (handle = requester's handle). " +
      "'cancel': For requests you SENT (handle = recipient's handle).",
    properties: {
      action: {
        type: "string",
        enum: ["approve", "reject", "cancel"],
        description: "Action to take.",
      },
      handle: {
        type: "string",
        description: "Other party's handle.",
      },
      request_id: {
        type: "string",
        description: "Or request ID (UUID).",
      },
    },
    required: ["action"],
  },
  band_list_memories: {
    description:
      "List memories accessible to the agent. " +
      "Use scope=\"agent\" for the caller's private memories, scope=\"subject\" for " +
      "memories about a specific person or agent, and scope=\"organization\" for " +
      "org-wide shared memories. Omit scope or use scope=\"all\" to search across scopes.",
    properties: {
      subject_id: {
        type: "string",
        description:
          "Filter by subject UUID (required for subject-scoped queries).",
      },
      scope: {
        type: "string",
        enum: [...MEMORY_LIST_SCOPES],
        description:
          "Filter by scope. \"agent\" returns the caller's private memories; " +
          "\"subject\" and \"organization\" filter to those audiences; \"all\" omits the filter.",
      },
      system: {
        type: "string",
        enum: [...MEMORY_SYSTEMS],
        description: "Filter by memory system.",
      },
      type: {
        type: "string",
        enum: [...MEMORY_TYPES],
        description: "Filter by memory type.",
      },
      segment: {
        type: "string",
        enum: [...MEMORY_SEGMENTS],
        description: "Filter by segment.",
      },
      content_query: {
        type: "string",
        description: "Full-text search query.",
      },
      page_size: {
        type: "integer",
        description: "Number of results per page.",
        minimum: 1,
        maximum: 50,
      },
      status: {
        type: "string",
        enum: [...MEMORY_STATUSES],
        description: "Filter by status.",
      },
    },
    required: [],
  },
  band_store_memory: {
    description:
      "Store a new memory entry. The memory will be associated with the authenticated agent " +
      "as the source. Use scope=\"agent\" for information private to this agent (no subject_id). " +
      "Use scope=\"subject\" with a subject_id for memories about a specific person or agent. " +
      "Use scope=\"organization\" for knowledge genuinely shared across the organization.",
    properties: {
      content: {
        type: "string",
        description: "The memory content.",
      },
      system: {
        type: "string",
        enum: [...MEMORY_SYSTEMS],
        description: "Memory system tier.",
      },
      type: {
        type: "string",
        enum: [...MEMORY_TYPES],
        description: "Memory type (must be valid for selected system).",
      },
      segment: {
        type: "string",
        enum: [...MEMORY_SEGMENTS],
        description: "Logical segment.",
      },
      thought: {
        type: "string",
        description: "Agent's reasoning for storing this memory.",
      },
      scope: {
        type: "string",
        enum: [...MEMORY_STORE_SCOPES],
        description:
          "Visibility scope. \"agent\" is private to this agent; \"subject\" requires subject_id; " +
          "\"organization\" is shared org-wide.",
      },
      subject_id: {
        type: "string",
        description:
          "UUID of the subject this memory is about (required for subject scope; omit for agent scope).",
      },
      metadata: {
        type: "object",
        description: "Additional metadata (tags, references).",
      },
    },
    required: ["content", "system", "type", "segment", "thought"],
  },
  band_get_memory: {
    description: "Retrieve a specific memory by ID.",
    properties: {
      memory_id: {
        type: "string",
        description: "Memory ID (UUID).",
      },
    },
    required: ["memory_id"],
  },
  band_supersede_memory: {
    description:
      "Mark a memory as superseded (soft delete). " +
      "Use when information is outdated or incorrect. " +
      "The memory remains for audit trail but won't appear in normal queries. " +
      "Only the source agent can supersede.",
    properties: {
      memory_id: {
        type: "string",
        description: "Memory ID (UUID).",
      },
    },
    required: ["memory_id"],
  },
  band_archive_memory: {
    description:
      "Archive a memory (hide but preserve). " +
      "Use when memory is valid but not currently needed. " +
      "Archived memories can be restored later by humans. " +
      "Only the source agent can archive.",
    properties: {
      memory_id: {
        type: "string",
        description: "Memory ID (UUID).",
      },
    },
    required: ["memory_id"],
  },
} as const;

export type ToolName = keyof typeof TOOL_MODELS;

// Every SDK tool is one of core's, so each records with core's effect; a
// TS-only or misspelled name fails to compile here.
const _everyToolIsCores: BandToolName = null as unknown as ToolName;

export const ALL_TOOL_NAMES = new Set(Object.keys(TOOL_MODELS));

/**
 * The adapter method each tool's handler dispatches to (`null`: none), so a
 * direct call such as `tools.sendMessage` counts toward the turn the same as
 * the model's tool call. Typed over every tool, so a new tool cannot be left out.
 */
export const TOOL_METHODS: Record<ToolName, AdapterToolMethodName | null> = {
  band_send_message: "sendMessage",
  band_send_event: "sendEvent",
  band_no_reply: null,
  band_add_participant: "addParticipant",
  band_remove_participant: "removeParticipant",
  band_lookup_peers: "lookupPeers",
  band_get_participants: "getParticipants",
  band_create_chatroom: "createChatroom",
  band_list_contacts: "listContacts",
  band_add_contact: "addContact",
  band_remove_contact: "removeContact",
  band_list_contact_requests: "listContactRequests",
  band_respond_contact_request: "respondContactRequest",
  band_list_memories: "listMemories",
  band_store_memory: "storeMemory",
  band_get_memory: "getMemory",
  band_supersede_memory: "supersedeMemory",
  band_archive_memory: "archiveMemory",
};

export const MEMORY_TOOL_NAMES = new Set<string>([
  "band_list_memories",
  "band_store_memory",
  "band_get_memory",
  "band_supersede_memory",
  "band_archive_memory",
]);

export const CONTACT_TOOL_NAMES = new Set<string>([
  "band_list_contacts",
  "band_add_contact",
  "band_remove_contact",
  "band_list_contact_requests",
  "band_respond_contact_request",
]);

/** The tools that act on a room, and so take its id. */
export const ROOM_TOOL_NAMES = new Set<string>([
  SEND_MESSAGE_TOOL_NAME,
  SEND_EVENT_TOOL_NAME,
  "band_add_participant",
  "band_remove_participant",
  "band_get_participants",
  "band_lookup_peers",
]);

export const BASE_TOOL_NAMES = new Set<string>(
  [...ALL_TOOL_NAMES].filter((name) => !MEMORY_TOOL_NAMES.has(name)),
);

export const CHAT_TOOL_NAMES = new Set<string>(
  [...BASE_TOOL_NAMES].filter((name) => !CONTACT_TOOL_NAMES.has(name)),
);

export const MCP_TOOL_PREFIX = "mcp__band__";

/** The single Band MCP server name; owns every server-name default and integration. */
export const MCP_SERVER_NAME = "band";

/** How an out-of-process runtime spells an MCP tool: `<server>-<tool>`. */
export function mcpToolSpelling(server: string, tool: string): string {
  return `${server}-${tool}`;
}

/** band-mcp's send-message name before it adopted `band_send_message`; older servers still report it. */
export const LEGACY_SEND_MESSAGE_TOOL_NAME = "create_agent_chat_message";

/** What each Band tool's successful call contributes to its turn, from band-sdk-core. */
export const BAND_TOOL_EFFECTS: Readonly<Record<BandToolName, TurnEffect>> = bandToolEffects();

export function isBandToolName(name: string): name is BandToolName {
  return Object.hasOwn(BAND_TOOL_EFFECTS, name);
}

/**
 * The Band tool behind a name an out-of-process runtime reported: the
 * canonical name, our MCP server's `band-<tool>` spelling, or band-mcp's
 * legacy send name. Anchored to {@link MCP_SERVER_NAME}, so another server's
 * `other-band_send_message` is not ours.
 */
export function resolveBandToolName(name: string): BandToolName | undefined {
  const prefix = mcpToolSpelling(MCP_SERVER_NAME, "");
  const unprefixed = name.startsWith(prefix) ? name.slice(prefix.length) : name;
  if (unprefixed === LEGACY_SEND_MESSAGE_TOOL_NAME) {
    return SEND_MESSAGE_TOOL_NAME;
  }
  return isBandToolName(unprefixed) ? unprefixed : undefined;
}

export function mcpToolNames(names: Set<string>): string[] {
  return [...names].sort((a, b) => a.localeCompare(b)).map((name) => `${MCP_TOOL_PREFIX}${name}`);
}

export function getToolDescription(name: string): string {
  const model = TOOL_MODELS[name as keyof typeof TOOL_MODELS];
  return model?.description ?? `Execute ${name}`;
}
