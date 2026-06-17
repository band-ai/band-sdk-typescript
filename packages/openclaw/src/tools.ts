/**
 * Band platform-management tools.
 *
 * These are the capabilities core has no equivalent for (peers, participants,
 * chatroom creation, structured events, contacts + contact requests). The
 * normal "say something in the room" path is NOT a tool — it flows through the
 * shared message tool + outbound adapter (the legacy `*_send_message` tool is
 * dropped). 12 tools total.
 *
 * Handlers take an injected `BandToolContext` ({ rest, selfAgentId }) so they
 * are unit-testable with vi.fn() spies and hold no global state; the
 * registration layer supplies the live context from the connected account.
 */

import type { ThenvoiLink } from "@thenvoi/sdk";

type BandRest = ThenvoiLink["rest"];

export interface BandToolContext {
  rest: BandRest;
  selfAgentId: string;
}

interface BandInputSchema {
  type: "object";
  properties: Record<string, BandProperty>;
  required?: string[];
}

interface BandProperty {
  type: string;
  description: string;
  default?: unknown;
  enum?: string[];
  items?: { type: string };
}

export interface BandTool {
  name: string;
  description: string;
  inputSchema: BandInputSchema;
  handler: (ctx: BandToolContext, params: unknown) => Promise<unknown>;
}

// =============================================================================
// Param shapes
// =============================================================================

interface LookupPeersParams { page?: number; page_size?: number }
interface AddParticipantParams { room_id: string; handle: string; role?: string }
interface RemoveParticipantParams { room_id: string; name?: string; participant_id?: string }
interface GetParticipantsParams { room_id: string }
interface CreateChatroomParams { task_id?: string }
interface SendEventParams { room_id: string; content: string; message_type: string; metadata?: Record<string, unknown> }
interface ListChatsParams { page?: number; page_size?: number }
interface ListContactsParams { page?: number; page_size?: number }
interface AddContactParams { handle: string; message?: string }
interface RemoveContactParams { handle?: string; contact_id?: string }
interface ListContactRequestsParams { page?: number; page_size?: number; sent_status?: string }
interface RespondContactRequestParams { action: "approve" | "reject" | "cancel"; handle?: string; request_id?: string }

// =============================================================================
// Helpers
// =============================================================================

/** Assert an optional REST method exists, returning it bound to `rest`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function requireMethod<T extends (...args: any[]) => any>(
  rest: object,
  method: T | undefined,
  name: string,
): T {
  if (!method) {
    throw new Error(`REST method "${name}" is not available on this API adapter`);
  }
  return method.bind(rest) as T;
}

function clampPagination(page: number, pageSize: number): { page: number; pageSize: number } {
  return {
    page: Math.max(1, Math.floor(page)),
    pageSize: Math.max(1, Math.min(100, Math.floor(pageSize))),
  };
}

// =============================================================================
// Tools
// =============================================================================

const lookupPeersTool: BandTool = {
  name: "band_lookup_peers",
  description:
    "Find available agents and users on the Band platform. " +
    "Use this to discover who you can invite to collaborate.",
  inputSchema: {
    type: "object",
    properties: {
      page: { type: "number", description: "Page number for pagination (default: 1)", default: 1 },
      page_size: { type: "number", description: "Results per page (default: 50, max: 100)", default: 50 },
    },
  },
  handler: async (ctx, params) => {
    const { page: rawPage = 1, page_size: rawPageSize = 50 } = params as LookupPeersParams;
    const { page, pageSize } = clampPagination(rawPage, rawPageSize);
    const response = await requireMethod(ctx.rest, ctx.rest.listPeers, "listPeers")({ page, pageSize, notInChat: "" });
    return {
      peers: (response.data ?? []).map((peer) => ({
        id: peer.id,
        handle: peer.handle,
        name: peer.name,
        type: peer.type,
        description: peer.description,
      })),
      total: response.metadata?.totalCount ?? 0,
      has_more: (response.metadata?.page ?? 1) < (response.metadata?.totalPages ?? 1),
    };
  },
};

const addParticipantTool: BandTool = {
  name: "band_add_participant",
  description:
    "Invite an agent or user to join a Band chat room. " +
    "Use band_lookup_peers first to find available participants. " +
    "room_id must be the value from the [Band Room: ...] marker — not an agent/user/owner id.",
  inputSchema: {
    type: "object",
    properties: {
      room_id: { type: "string", description: "Chat room UUID from the [Band Room: ...] marker." },
      handle: { type: "string", description: "Handle of the agent/user to invite (e.g. '@john'). Can also be a name or UUID." },
      role: { type: "string", description: "Role (default: member)", default: "member", enum: ["owner", "admin", "member"] },
    },
    required: ["room_id", "handle"],
  },
  handler: async (ctx, params) => {
    const { room_id, handle, role = "member" } = params as AddParticipantParams;
    const listPeers = requireMethod(ctx.rest, ctx.rest.listPeers, "listPeers");
    const normalizedHandle = handle.replace(/^@/, "").toLowerCase();
    let foundPeerId: string | undefined;
    let foundPeerName: string | undefined;
    let foundPeerType: string | undefined;
    let page = 1;
    const pageSize = 100;
    const maxPages = 10;

    while (!foundPeerId && page <= maxPages) {
      const peersResponse = await listPeers({ page, pageSize, notInChat: "" });
      const match = (peersResponse.data ?? []).find(
        (p) =>
          p.name?.toLowerCase() === normalizedHandle ||
          p.handle?.replace(/^@/, "").toLowerCase() === normalizedHandle,
      );
      if (match?.id) {
        foundPeerId = match.id;
        foundPeerName = match.name;
        foundPeerType = match.type;
        break;
      }
      const totalPages = peersResponse.metadata?.totalPages ?? 1;
      if (page >= totalPages) break;
      page++;
    }

    if (!foundPeerId) {
      throw new Error(`Peer not found: "${handle}". Use band_lookup_peers to see available peers.`);
    }

    const response = await ctx.rest.addChatParticipant(room_id, { participantId: foundPeerId, role });
    return {
      success: true,
      participant: { id: foundPeerId, name: foundPeerName, type: foundPeerType, role },
      response,
    };
  },
};

const removeParticipantTool: BandTool = {
  name: "band_remove_participant",
  description: "Remove an agent or user from a Band chat room.",
  inputSchema: {
    type: "object",
    properties: {
      room_id: { type: "string", description: "Chat room UUID from the [Band Room: ...] marker." },
      name: { type: "string", description: "Name of the participant to remove (resolved to id via the participants list)." },
      participant_id: { type: "string", description: "Or the participant UUID directly (skips name resolution)." },
    },
    required: ["room_id"],
  },
  handler: async (ctx, params) => {
    const { room_id, name, participant_id } = params as RemoveParticipantParams;
    let resolvedId = participant_id;
    let resolvedName = name ?? participant_id;

    if (!resolvedId) {
      if (!name) {
        throw new Error("Either name or participant_id is required");
      }
      const participants = await ctx.rest.listChatParticipants(room_id);
      const match = participants.find(
        (p) => p.name.toLowerCase() === name.toLowerCase() && p.id !== ctx.selfAgentId,
      );
      if (!match) {
        throw new Error(`Participant "${name}" not found in room. Use band_get_participants to see current participants.`);
      }
      resolvedId = match.id;
      resolvedName = match.name;
    }

    await ctx.rest.removeChatParticipant(room_id, resolvedId);
    return { success: true, message: `Removed ${resolvedName} from room` };
  },
};

const getParticipantsTool: BandTool = {
  name: "band_get_participants",
  description: "List all participants in a Band chat room.",
  inputSchema: {
    type: "object",
    properties: {
      room_id: { type: "string", description: "Chat room UUID from the [Band Room: ...] marker." },
    },
    required: ["room_id"],
  },
  handler: async (ctx, params) => {
    const { room_id } = params as GetParticipantsParams;
    const participants = await ctx.rest.listChatParticipants(room_id);
    return {
      participants: participants.map((p) => ({ id: p.id, name: p.name, type: p.type })),
      count: participants.length,
    };
  },
};

const createChatroomTool: BandTool = {
  name: "band_create_chatroom",
  description:
    "Create a new Band chat room for collaboration. " +
    "Use this when you need a fresh space for a new task or conversation.",
  inputSchema: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Optional task ID to associate with the room" },
    },
  },
  handler: async (ctx, params) => {
    const { task_id } = params as CreateChatroomParams;
    const response = await ctx.rest.createChat(task_id);
    return { success: true, room_id: response.id, message: "Chat room created successfully" };
  },
};

const EVENT_TYPES = ["thought", "error", "task", "tool_call", "tool_result"] as const;
type EventType = (typeof EVENT_TYPES)[number];

const sendEventTool: BandTool = {
  name: "band_send_event",
  description:
    "Share a STRUCTURED ACTIVITY EVENT with other participants in a Band chat room. " +
    "Types: 'thought', 'error', 'task', 'tool_call' (metadata: tool_call_id, name, args), " +
    "'tool_result' (metadata: tool_call_id, name, output). " +
    "Do NOT use this to send a normal chat message — use the `message` tool (channel=band, " +
    "target=room_id) for that. This is only for surfacing your activity/progress.",
  inputSchema: {
    type: "object",
    properties: {
      room_id: { type: "string", description: "Chat room UUID from the [Band Room: ...] marker." },
      content: { type: "string", description: "Human-readable content of the event" },
      message_type: { type: "string", description: "Type of event", enum: ["thought", "error", "task", "tool_call", "tool_result"] },
      metadata: { type: "object", description: "Optional structured metadata." },
    },
    required: ["room_id", "content", "message_type"],
  },
  handler: async (ctx, params) => {
    const { room_id, content, message_type, metadata } = params as SendEventParams;
    // Agent-driven events are easy to hallucinate; fail fast on an unknown type
    // instead of silently posting a malformed event (JSON-schema enums are only
    // advisory to the model, not enforced at the handler boundary).
    if (!EVENT_TYPES.includes(message_type as EventType)) {
      throw new Error(
        `Invalid message_type "${message_type}". Must be one of: ${EVENT_TYPES.join(", ")}`,
      );
    }
    const response = await ctx.rest.createChatEvent(room_id, { content, messageType: message_type, metadata });
    return { success: true, event_id: response.id, message_type };
  },
};

const listChatsTool: BandTool = {
  name: "band_list_chats",
  description:
    "List the Band chat rooms you are in (paginated). Use this to DISCOVER room ids " +
    "(UUIDs) to send a message to or manage — you don't have to wait for an inbound " +
    "[Band Room: ...] marker. Pass a returned room id as the `target` of the `message` " +
    "tool (channel=band) to send into that room.",
  inputSchema: {
    type: "object",
    properties: {
      page: { type: "number", description: "Page number (default: 1)", default: 1 },
      page_size: { type: "number", description: "Results per page (default: 50, max: 100)", default: 50 },
    },
  },
  handler: async (ctx, params) => {
    const { page: rawPage = 1, page_size: rawPageSize = 50 } = params as ListChatsParams;
    const { page, pageSize } = clampPagination(rawPage, rawPageSize);
    const response = await requireMethod(ctx.rest, ctx.rest.listChats, "listChats")({ page, pageSize });
    return {
      chats: (response.data ?? []).map((chat) => ({
        id: chat.id,
        name: chat.name,
        type: chat.type,
      })),
      metadata: response.metadata,
    };
  },
};

const listContactsTool: BandTool = {
  name: "band_list_contacts",
  description: "List the agent's contacts with pagination.",
  inputSchema: {
    type: "object",
    properties: {
      page: { type: "number", description: "Page number (default: 1)", default: 1 },
      page_size: { type: "number", description: "Items per page (default: 50, max: 100)", default: 50 },
    },
  },
  handler: async (ctx, params) => {
    const { page: rawPage = 1, page_size: rawPageSize = 50 } = params as ListContactsParams;
    const { page, pageSize } = clampPagination(rawPage, rawPageSize);
    const response = await requireMethod(ctx.rest, ctx.rest.listContacts, "listContacts")({ page, pageSize });
    return {
      contacts: (response.data ?? []).map((c) => ({ id: c.id, handle: c.handle, name: c.name, type: c.type })),
      metadata: response.metadata,
    };
  },
};

const addContactTool: BandTool = {
  name: "band_add_contact",
  description:
    "Send a contact request to add someone as a contact. Returns 'pending' when created, " +
    "'approved' when auto-accepted (if they already sent you a request).",
  inputSchema: {
    type: "object",
    properties: {
      handle: { type: "string", description: "Handle of user/agent to add (e.g. '@john')" },
      message: { type: "string", description: "Optional message with the request" },
    },
    required: ["handle"],
  },
  handler: async (ctx, params) => {
    const { handle, message } = params as AddContactParams;
    const response = await requireMethod(ctx.rest, ctx.rest.addContact, "addContact")({ handle, message });
    return { success: true, ...response };
  },
};

const removeContactTool: BandTool = {
  name: "band_remove_contact",
  description: "Remove an existing contact by handle or ID.",
  inputSchema: {
    type: "object",
    properties: {
      handle: { type: "string", description: "Contact's handle" },
      contact_id: { type: "string", description: "Or contact record ID (UUID)" },
    },
  },
  handler: async (ctx, params) => {
    const { handle, contact_id } = params as RemoveContactParams;
    if (!handle && !contact_id) {
      throw new Error("Either handle or contact_id is required");
    }
    const removeArgs = handle
      ? { target: "handle" as const, handle }
      : { target: "contactId" as const, contactId: contact_id! };
    await requireMethod(ctx.rest, ctx.rest.removeContact, "removeContact")(removeArgs);
    return { success: true, message: "Contact removed" };
  },
};

const listContactRequestsTool: BandTool = {
  name: "band_list_contact_requests",
  description:
    "List received and sent contact requests. Received are filtered to pending; sent can be " +
    "filtered by status.",
  inputSchema: {
    type: "object",
    properties: {
      page: { type: "number", description: "Page number (default: 1)", default: 1 },
      page_size: { type: "number", description: "Items per page per direction (default: 50, max: 100)", default: 50 },
      sent_status: { type: "string", description: "Filter sent requests (default: pending)", default: "pending", enum: ["pending", "approved", "rejected", "cancelled", "all"] },
    },
  },
  handler: async (ctx, params) => {
    const { page: rawPage = 1, page_size: rawPageSize = 50, sent_status = "pending" } = params as ListContactRequestsParams;
    const { page, pageSize } = clampPagination(rawPage, rawPageSize);
    const response = await requireMethod(ctx.rest, ctx.rest.listContactRequests, "listContactRequests")({ page, pageSize, sentStatus: sent_status });
    return {
      received: (response.received ?? []).map((r) => ({ id: r.id, from_handle: r.from_handle, from_name: r.from_name, message: r.message, status: r.status })),
      sent: (response.sent ?? []).map((s) => ({ id: s.id, to_handle: s.to_handle, to_name: s.to_name, message: s.message, status: s.status })),
      metadata: response.metadata,
    };
  },
};

const respondContactRequestTool: BandTool = {
  name: "band_respond_contact_request",
  description:
    "Respond to a contact request. 'approve'/'reject' for requests you RECEIVED, 'cancel' for " +
    "requests you SENT.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "Action to take", enum: ["approve", "reject", "cancel"] },
      handle: { type: "string", description: "Other party's handle" },
      request_id: { type: "string", description: "Or request ID (UUID)" },
    },
    required: ["action"],
  },
  handler: async (ctx, params) => {
    const { action, handle, request_id } = params as RespondContactRequestParams;
    if (!handle && !request_id) {
      throw new Error("Either handle or request_id is required");
    }
    const respondArgs = handle
      ? { action, target: "handle" as const, handle }
      : { action, target: "requestId" as const, requestId: request_id! };
    const response = await requireMethod(ctx.rest, ctx.rest.respondContactRequest, "respondContactRequest")(respondArgs);
    return { success: true, ...response };
  },
};

// =============================================================================
// Registry
// =============================================================================

export const bandTools: BandTool[] = [
  lookupPeersTool,
  addParticipantTool,
  removeParticipantTool,
  getParticipantsTool,
  createChatroomTool,
  sendEventTool,
  listChatsTool,
  listContactsTool,
  addContactTool,
  removeContactTool,
  listContactRequestsTool,
  respondContactRequestTool,
];

export function getBandTool(name: string): BandTool | undefined {
  return bandTools.find((tool) => tool.name === name);
}

export async function executeBandTool(
  ctx: BandToolContext,
  name: string,
  params: unknown,
): Promise<unknown> {
  const tool = getBandTool(name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return tool.handler(ctx, params ?? {});
}

export function getBandToolSchemas(): Array<{ name: string; description: string; inputSchema: BandInputSchema }> {
  return bandTools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
}
