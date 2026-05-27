import { CHAT_EVENT_TYPES } from "../../contracts/chatEvents";

export const TOOL_MODELS = {
  thenvoi_send_message: {
    description:
      "Send a message to the chat room. " +
      "Use this to respond to users or other agents. Messages require at least one @mention " +
      "in the mentions array. You MUST use this tool to communicate — plain text responses " +
      "won't reach users. When delegating, send the full task context in this message instead of assuming hidden state.",
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
  thenvoi_send_event: {
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
  thenvoi_add_participant: {
    description:
      "Add a participant (agent or user) to the chat room by name. " +
      "IMPORTANT: Use thenvoi_lookup_peers() first to find available agents. " +
      "Pass the exact peer name from thenvoi_lookup_peers, not the handle. " +
      "For normal delegation, omit role or use 'member'.",
    properties: {
      name: {
        type: "string",
        description:
          "Name of participant to add (must match a name from thenvoi_lookup_peers).",
      },
      role: {
        type: "string",
        enum: ["owner", "admin", "member"],
        description: "Role for the participant in this room.",
      },
    },
    required: ["name"],
  },
  thenvoi_remove_participant: {
    description: "Remove a participant from the chat room by name.",
    properties: {
      name: {
        type: "string",
        description: "Name of the participant to remove.",
      },
    },
    required: ["name"],
  },
  thenvoi_get_participants: {
    description: "Get a list of all participants in the current chat room.",
    properties: {},
    required: [],
  },
  thenvoi_lookup_peers: {
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
  thenvoi_create_chatroom: {
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
  thenvoi_list_contacts: {
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
  thenvoi_add_contact: {
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
  thenvoi_remove_contact: {
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
  thenvoi_list_contact_requests: {
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
  thenvoi_respond_contact_request: {
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
  thenvoi_list_memories: {
    description:
      "List memories accessible to the agent. " +
      "Returns memories about the specified subject (cross-agent sharing) " +
      "and organization-wide shared memories.",
    properties: {
      subject_id: {
        type: "string",
        description:
          "Filter by subject UUID (required for subject-scoped queries).",
      },
      scope: {
        type: "string",
        enum: ["subject", "organization", "all"],
        description: "Filter by scope.",
      },
      system: {
        type: "string",
        enum: ["sensory", "working", "long_term"],
        description: "Filter by memory system.",
      },
      type: {
        type: "string",
        enum: [
          "iconic",
          "echoic",
          "haptic",
          "episodic",
          "semantic",
          "procedural",
        ],
        description: "Filter by memory type.",
      },
      segment: {
        type: "string",
        enum: ["user", "agent", "tool", "guideline"],
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
        enum: ["active", "superseded", "archived", "all"],
        description: "Filter by status.",
      },
    },
    required: [],
  },
  thenvoi_store_memory: {
    description:
      "Store a new memory entry. The memory will be associated with the authenticated agent " +
      "as the source. For subject-scoped memories, provide a subject_id. " +
      "For organization-scoped memories, omit subject_id.",
    properties: {
      content: {
        type: "string",
        description: "The memory content.",
      },
      system: {
        type: "string",
        enum: ["sensory", "working", "long_term"],
        description: "Memory system tier.",
      },
      type: {
        type: "string",
        enum: [
          "iconic",
          "echoic",
          "haptic",
          "episodic",
          "semantic",
          "procedural",
        ],
        description: "Memory type (must be valid for selected system).",
      },
      segment: {
        type: "string",
        enum: ["user", "agent", "tool", "guideline"],
        description: "Logical segment.",
      },
      thought: {
        type: "string",
        description: "Agent's reasoning for storing this memory.",
      },
      scope: {
        type: "string",
        enum: ["subject", "organization"],
        description: "Visibility scope.",
      },
      subject_id: {
        type: "string",
        description:
          "UUID of the subject this memory is about (required for subject scope).",
      },
      metadata: {
        type: "object",
        description: "Additional metadata (tags, references).",
      },
    },
    required: ["content", "system", "type", "segment", "thought"],
  },
  thenvoi_get_memory: {
    description: "Retrieve a specific memory by ID.",
    properties: {
      memory_id: {
        type: "string",
        description: "Memory ID (UUID).",
      },
    },
    required: ["memory_id"],
  },
  thenvoi_supersede_memory: {
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
  thenvoi_archive_memory: {
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

export const TOOL_NAME_ALIASES = {
  band_send_message: "thenvoi_send_message",
  band_send_event: "thenvoi_send_event",
  band_add_participant: "thenvoi_add_participant",
  band_remove_participant: "thenvoi_remove_participant",
  band_get_participants: "thenvoi_get_participants",
  band_lookup_peers: "thenvoi_lookup_peers",
  band_create_chatroom: "thenvoi_create_chatroom",
  band_list_contacts: "thenvoi_list_contacts",
  band_add_contact: "thenvoi_add_contact",
  band_remove_contact: "thenvoi_remove_contact",
  band_list_contact_requests: "thenvoi_list_contact_requests",
  band_respond_contact_request: "thenvoi_respond_contact_request",
  band_list_memories: "thenvoi_list_memories",
  band_store_memory: "thenvoi_store_memory",
  band_get_memory: "thenvoi_get_memory",
  band_supersede_memory: "thenvoi_supersede_memory",
  band_archive_memory: "thenvoi_archive_memory",
} as const satisfies Record<string, keyof typeof TOOL_MODELS>;

export function canonicalToolName(name: string): string {
  return TOOL_NAME_ALIASES[name as keyof typeof TOOL_NAME_ALIASES] ?? name;
}

export function legacyToolNamesForCanonical(name: string): string[] {
  return Object.entries(TOOL_NAME_ALIASES)
    .filter(([, canonical]) => canonical === name)
    .map(([legacy]) => legacy);
}

export const ALL_TOOL_NAMES = new Set(Object.keys(TOOL_MODELS));

export const MEMORY_TOOL_NAMES = new Set<string>([
  "thenvoi_list_memories",
  "thenvoi_store_memory",
  "thenvoi_get_memory",
  "thenvoi_supersede_memory",
  "thenvoi_archive_memory",
]);

export const CONTACT_TOOL_NAMES = new Set<string>([
  "thenvoi_list_contacts",
  "thenvoi_add_contact",
  "thenvoi_remove_contact",
  "thenvoi_list_contact_requests",
  "thenvoi_respond_contact_request",
]);

export const BASE_TOOL_NAMES = new Set<string>(
  [...ALL_TOOL_NAMES].filter((name) => !MEMORY_TOOL_NAMES.has(name)),
);

export const CHAT_TOOL_NAMES = new Set<string>(
  [...BASE_TOOL_NAMES].filter((name) => !CONTACT_TOOL_NAMES.has(name)),
);

export const MCP_TOOL_PREFIX = "mcp__thenvoi__";

export function mcpToolNames(names: Set<string>): string[] {
  return [...names].sort((a, b) => a.localeCompare(b)).map((name) => `${MCP_TOOL_PREFIX}${name}`);
}

export function getToolDescription(name: string): string {
  const model = TOOL_MODELS[name as keyof typeof TOOL_MODELS];
  return model?.description ?? `Execute ${name}`;
}
