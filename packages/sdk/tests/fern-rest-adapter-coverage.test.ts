import { describe, expect, it, vi } from "vitest";

import { UnsupportedFeatureError } from "../src/core/errors";
import {
  FernRestAdapter,
  isFernRateLimitError,
  normalizeFernContactRequestsResponse,
  normalizeFernPaginatedResponse,
} from "../src/client/rest/FernRestAdapter";

function rateLimitError(message = "rate limited"): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 429 });
}

describe("FernRestAdapter coverage", () => {
  it("throws when no identity endpoint exists", async () => {
    const adapter = new FernRestAdapter({});

    await expect(adapter.getAgentMe()).rejects.toBeInstanceOf(UnsupportedFeatureError);
  });

  it("retries getAgentMe on 429s and then returns the normalized identity", async () => {
    const getAgentMe = vi.fn()
      .mockRejectedValueOnce(rateLimitError())
      .mockResolvedValueOnce({
        data: {
          id: "a1",
          name: "Agent",
          description: null,
          handle: "@agent",
          owner_uuid: "owner-1",
        },
      });
    const adapter = new FernRestAdapter({
      agentApiIdentity: { getAgentMe },
    });

    await expect(adapter.getAgentMe()).resolves.toEqual({
      id: "a1",
      name: "Agent",
      description: null,
      handle: "@agent",
      ownerUuid: "owner-1",
    });
    expect(getAgentMe).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid identity payloads", async () => {
    const adapter = new FernRestAdapter({
      agentApiIdentity: {
        getAgentMe: async () => ({ data: { id: "a1", name: 42 } }),
      },
    });

    await expect(adapter.getAgentMe()).rejects.toThrow("expected non-empty string AgentIdentity.name");
  });

  it("detects rate limits from structured status codes", () => {
    expect(isFernRateLimitError(rateLimitError())).toBe(true);
    expect(isFernRateLimitError(new Error("429"))).toBe(false);
  });

  it("falls back to legacy profile identity when agentApiIdentity is missing", async () => {
    const adapter = new FernRestAdapter({
      humanApiProfile: {
        getMyProfile: async () => ({
          data: {
            id: "legacy-1",
            first_name: "Legacy",
            last_name: "Agent",
            description: "legacy",
          },
        }),
      },
    });

    await expect(adapter.getAgentMe()).resolves.toEqual({
      id: "legacy-1",
      name: "Legacy Agent",
      description: "legacy",
      handle: null,
      ownerUuid: null,
    });
  });

  it("throws when createChat returns no room id", async () => {
    const adapter = new FernRestAdapter({
      agentApiChats: {
        createAgentChat: async () => ({ data: {} }),
      },
    });

    await expect(adapter.createChat()).rejects.toThrow("Chat create response did not include id");
  });

  it("uses the modern chat and event namespaces when they exist", async () => {
    const createChatMessage = vi.fn(async () => ({ data: { ok: true, id: "msg-1" } }));
    const createAgentChatEvent = vi.fn(async () => ({ data: { ok: true, id: "evt-1" } }));
    const createChat = vi.fn(async () => ({ data: { id: "room-9" } }));
    const addChatParticipant = vi.fn(async () => ({ data: { status: "added" } }));
    const removeChatParticipant = vi.fn(async () => ({ data: { status: "removed" } }));
    const markMessageProcessing = vi.fn(async () => ({ data: { status: "processing" } }));
    const markMessageProcessed = vi.fn(async () => ({ data: { status: "processed" } }));
    const markMessageFailed = vi.fn(async () => ({ data: { status: "failed" } }));
    const listMessages = vi.fn(async () => ({
      data: [
        {
          id: "m1",
          content: "Hello",
          senderId: "u1",
          senderType: "User",
          senderName: "Jane",
          messageType: "text",
          insertedAt: "2026-03-10T00:00:00.000Z",
          updatedAt: null,
          metadata: { ok: true },
        },
        { bad: true },
      ],
      metadata: { page: 2, page_size: 25, total_count: 1, total_pages: 4 },
    }));
    const getChatContext = vi.fn(async () => ({
      data: {
        data: [
          {
            id: "ctx-1",
            content: "Context",
            sender_id: "u2",
            sender_type: "User",
            message_type: "text",
            inserted_at: "2026-03-10T00:00:00.000Z",
          },
        ],
        metadata: { page: 1, page_size: 5, total_count: 1, total_pages: 1 },
      },
    }));
    const adapter = new FernRestAdapter({
      chatMessages: {
        createChatMessage,
        markMessageProcessing,
        markMessageProcessed,
        markMessageFailed,
        listMessages,
      },
      agentApiEvents: {
        createAgentChatEvent,
      },
      chatRooms: {
        createChat,
      },
      chatParticipants: {
        listChatParticipants: async () => ({ data: [] }),
        addChatParticipant,
        removeChatParticipant,
      },
      chatContext: {
        getChatContext,
      },
    });

    await expect(
      adapter.createChatMessage("room-1", {
        content: "hello",
        messageType: "text",
        metadata: { a: 1 },
        mentions: [{ id: "u1", handle: "@jane" }],
      }),
    ).resolves.toEqual({ ok: true, id: "msg-1" });
    await expect(
      adapter.createChatEvent("room-1", { content: "evt", messageType: "task", metadata: { x: true } }),
    ).resolves.toEqual({ ok: true, id: "evt-1" });
    await expect(adapter.createChat("task-1")).resolves.toEqual({ id: "room-9" });
    await expect(
      adapter.addChatParticipant("room-1", { participantId: "user-1", role: "member" }),
    ).resolves.toEqual({ status: "added" });
    await expect(adapter.removeChatParticipant("room-1", "user-1")).resolves.toEqual({ status: "removed" });
    await expect(adapter.markMessageProcessing("room-1", "m1")).resolves.toEqual({ status: "processing" });
    await expect(adapter.markMessageProcessed("room-1", "m1")).resolves.toEqual({ status: "processed" });
    await expect(adapter.markMessageFailed("room-1", "m1", "boom")).resolves.toEqual({ status: "failed" });
    await expect(
      adapter.listMessages({ chatId: "room-1", page: 2, pageSize: 25, status: "pending" }),
    ).resolves.toEqual({
      data: [
        {
          id: "m1",
          content: "Hello",
          sender_id: "u1",
          sender_type: "User",
          sender_name: "Jane",
          message_type: "text",
          inserted_at: "2026-03-10T00:00:00.000Z",
          updated_at: null,
          metadata: { ok: true },
        },
      ],
      metadata: { page: 2, pageSize: 25, totalCount: 1, totalPages: 4 },
    });
    await expect(
      adapter.getChatContext({ chatId: "room-1", page: 1, pageSize: 5 }),
    ).resolves.toEqual({
      data: [
        {
          id: "ctx-1",
          content: "Context",
          sender_id: "u2",
          sender_type: "User",
          sender_name: undefined,
          message_type: "text",
          metadata: undefined,
          inserted_at: "2026-03-10T00:00:00.000Z",
          updated_at: undefined,
        },
      ],
      metadata: { page: 1, pageSize: 5, totalCount: 1, totalPages: 1 },
    });

    expect(createChatMessage).toHaveBeenCalledWith(
      "room-1",
      {
        message: {
          content: "hello",
          message_type: "text",
          metadata: { a: 1 },
          mentions: [{ id: "u1", handle: "@jane" }],
        },
      },
      expect.any(Object),
    );
    expect(createAgentChatEvent).toHaveBeenCalledWith(
      "room-1",
      {
        event: {
          content: "evt",
          message_type: "task",
          metadata: { x: true },
        },
      },
      expect.any(Object),
    );
  });

  it("retries chat message writes on structured 429 responses", async () => {
    const createChatMessage = vi.fn()
      .mockRejectedValueOnce(rateLimitError())
      .mockResolvedValueOnce({ data: { ok: true, id: "msg-1" } });
    const adapter = new FernRestAdapter({
      chatMessages: {
        createChatMessage,
      },
    });

    await expect(
      adapter.createChatMessage("room-1", {
        content: "hello",
        messageType: "text",
      }),
    ).resolves.toEqual({ ok: true, id: "msg-1" });
    expect(createChatMessage).toHaveBeenCalledTimes(2);
  });

  it("retries listMessages on 429 instead of letting the polling loop crash", async () => {
    const listMessages = vi.fn()
      .mockRejectedValueOnce(rateLimitError())
      .mockResolvedValueOnce({
        data: [
          {
            id: "m-1",
            content: "hi",
            messageType: "text",
            senderId: "u1",
            senderType: "User",
            insertedAt: "2026-03-10T00:00:00.000Z",
            updatedAt: null,
          },
        ],
        metadata: { page: 1, page_size: 50, total_count: 1, total_pages: 1 },
      });
    const adapter = new FernRestAdapter({
      chatMessages: {
        listMessages,
      },
    });

    const result = await adapter.listMessages({
      chatId: "room-1",
      page: 1,
      pageSize: 50,
      status: "processing",
    });

    expect(listMessages).toHaveBeenCalledTimes(2);
    expect(result.data.map((m) => m.id)).toEqual(["m-1"]);
  });

  it("falls back from createChatEvent to createChatMessage when the event endpoint is unavailable", async () => {
    const createMyChatMessage = vi.fn(async () => ({ data: { ok: true } }));
    const adapter = new FernRestAdapter({
      myChatMessages: {
        createMyChatMessage,
      },
    });

    await expect(adapter.createChatEvent("room-1", {
      content: "hello",
      messageType: "task",
    })).resolves.toEqual({ ok: true });
    expect(createMyChatMessage).toHaveBeenCalledOnce();
  });

  it("uses agent-style contact and memory endpoints and normalizes filtered payloads", async () => {
    const listAgentContacts = vi.fn(async () => ({
      data: [
        {
          id: "contact-1",
          handle: "@jane",
          name: "Jane",
          type: "User",
          description: null,
          is_external: false,
          inserted_at: "2026-03-10T00:00:00.000Z",
        },
        { id: 7 },
      ],
      metadata: { page: 3, page_size: 20, total_count: 1, total_pages: 9 },
    }));
    const addAgentContact = vi.fn(async () => ({ data: { id: "req-1", status: "pending" } }));
    const removeAgentContact = vi.fn(async () => ({ data: { status: "removed" } }));
    const listAgentContactRequests = vi.fn(async () => ({
      data: {
        received: [{ id: "r1", from_handle: "@jane", status: "pending" }],
        sent: [{ id: "r2", to_handle: "@bot", status: "approved" }],
      },
      metadata: {
        page: 2,
        page_size: 10,
        received: { total: 1, total_pages: 1 },
        sent: { total: 1, total_pages: 1 },
      },
    }));
    const respondToAgentContactRequest = vi.fn(async () => ({ data: { status: "approved" } }));
    const listAgentMemories = vi.fn(async () => ({
      data: [
        {
          id: "memory-1",
          content: "fact",
          system: "long_term",
          type: "semantic",
          segment: "user",
          scope: "subject",
          status: "active",
          metadata: { source: "test" },
          inserted_at: "2026-03-10T00:00:00.000Z",
        },
        { id: "bad", metadata: [] },
      ],
      meta: { page_size: 7, total_count: 1 },
    }));
    const createAgentMemory = vi.fn(async () => ({ data: { id: "memory-2", content: "new" } }));
    const getAgentMemory = vi.fn(async () => ({ data: { id: "memory-3", content: "stored" } }));
    const supersedeAgentMemory = vi.fn(async () => ({ data: { status: "superseded" } }));
    const archiveAgentMemory = vi.fn(async () => ({ data: { status: "archived" } }));
    const adapter = new FernRestAdapter({
      agentContacts: {
        listAgentContacts,
        addAgentContact,
        removeAgentContact,
        listAgentContactRequests,
        respondToAgentContactRequest,
      },
      agentMemories: {
        listAgentMemories,
        createAgentMemory,
        getAgentMemory,
        supersedeAgentMemory,
        archiveAgentMemory,
      },
    });

    await expect(adapter.listContacts({ page: 3, pageSize: 20 })).resolves.toEqual({
      data: [
        {
          id: "contact-1",
          handle: "@jane",
          name: "Jane",
          type: "User",
          description: null,
          is_external: false,
          inserted_at: "2026-03-10T00:00:00.000Z",
        },
      ],
      metadata: { page: 3, pageSize: 20, totalCount: 1, totalPages: 9 },
    });
    await expect(adapter.addContact({ handle: "@jane", message: "hello" })).resolves.toEqual({
      id: "req-1",
      status: "pending",
    });
    await expect(adapter.removeContact({ target: "contactId", contactId: "contact-1" })).resolves.toEqual({
      status: "removed",
    });
    await expect(
      adapter.listContactRequests({ page: 2, pageSize: 10, sentStatus: "approved" }),
    ).resolves.toMatchObject({
      received: [{ id: "r1", from_handle: "@jane", status: "pending" }],
      sent: [{ id: "r2", to_handle: "@bot", status: "approved" }],
      metadata: {
        page: 2,
        pageSize: 10,
        received: { total: 1, totalPages: 1 },
        sent: { total: 1, totalPages: 1 },
      },
    });
    await expect(
      adapter.respondContactRequest({ action: "approve", target: "handle", handle: "@jane" }),
    ).resolves.toEqual({ status: "approved" });
    await expect(
      adapter.listMemories({ page_size: 7 }),
    ).resolves.toEqual({
      data: [
        {
          id: "memory-1",
          content: "fact",
          system: "long_term",
          type: "semantic",
          segment: "user",
          scope: "subject",
          status: "active",
          metadata: { source: "test" },
          inserted_at: "2026-03-10T00:00:00.000Z",
        },
      ],
      metadata: { pageSize: 7, totalCount: 1 },
    });
    await expect(
      adapter.storeMemory({ content: "new memory", thought: "why", system: "working", type: "semantic", segment: "user" }),
    ).resolves.toEqual({ id: "memory-2", content: "new" });
    await expect(adapter.getMemory("memory-3")).resolves.toEqual({ id: "memory-3", content: "stored" });
    await expect(adapter.supersedeMemory("memory-3")).resolves.toEqual({ status: "superseded" });
    await expect(adapter.archiveMemory("memory-3")).resolves.toEqual({ status: "archived" });

    expect(removeAgentContact).toHaveBeenCalledWith({ contact_id: "contact-1" }, expect.any(Object));
    expect(respondToAgentContactRequest).toHaveBeenCalledWith(
      { action: "approve", handle: "@jane" },
      expect.any(Object),
    );
  });

  it("directly normalizes paginated envelopes and filters invalid items", () => {
    const response = normalizeFernPaginatedResponse(
      {
        data: {
          data: [{ id: "ok" }, { bad: true }],
          metadata: { page: 2, page_size: 10, total_count: 1, total_pages: 3 },
        },
      },
      (item) => (typeof item.id === "string" ? item.id : null),
    );

    expect(response).toEqual({
      data: ["ok"],
      metadata: { page: 2, pageSize: 10, totalCount: 1, totalPages: 3 },
    });
  });

  it("directly normalizes contact request envelopes", () => {
    const response = normalizeFernContactRequestsResponse({
      data: {
        received: [{ id: "r1", from_handle: "@jane", status: "pending" }],
        sent: [{ id: "s1", to_handle: "@bot", status: "approved" }],
      },
      metadata: {
        page: 1,
        page_size: 5,
        received: { total: 1, total_pages: 1 },
        sent: { total: 1, total_pages: 1 },
      },
    });

    expect(response.received).toHaveLength(1);
    expect(response.sent).toHaveLength(1);
    expect(response.metadata).toEqual({
      page: 1,
      pageSize: 5,
      received: { total: 1, totalPages: 1 },
      sent: { total: 1, totalPages: 1 },
    });
  });

  it("normalizes listChatParticipants from the chatParticipants namespace", async () => {
    const adapter = new FernRestAdapter({
      chatParticipants: {
        listChatParticipants: async () => ({
          data: [
            { id: "u1", name: "Jane", type: "User", handle: "@jane" },
            { id: 42 },
          ],
        }),
        addChatParticipant: async () => ({ data: {} }),
        removeChatParticipant: async () => ({ data: {} }),
      },
    });

    await expect(adapter.listChatParticipants("room-1")).resolves.toEqual([
      { id: "u1", name: "Jane", type: "User", handle: "@jane" },
    ]);
  });

  it("falls back to agent participant and next-message endpoints and handles invalid payloads", async () => {
    const adapter = new FernRestAdapter({
      agentApiParticipants: {
        listAgentChatParticipants: async () => ({
          data: [{ id: "u2", name: "Sam", type: "Agent", handle: null }],
        }),
      },
      agentApiMessages: {
        getAgentNextMessage: async () => ({ data: { nope: true } }),
      },
      agentApiPeers: {
        listAgentPeers: async () => ({
          data: [{ id: "peer-1", name: "Peer", type: "Agent", handle: null }, { id: [] }],
          metadata: { page: 1, page_size: 5, total_count: 1, total_pages: 1 },
        }),
      },
      agentApiChats: {
        listAgentChats: async () => ({
          data: [{ id: "room-1", title: "Room" }, null],
          metadata: { page: 1, page_size: 5, total_count: 1, total_pages: 1 },
        }),
      },
    });

    await expect(adapter.listChatParticipants("room-1")).resolves.toEqual([
      { id: "u2", name: "Sam", type: "Agent", handle: null },
    ]);
    await expect(adapter.getNextMessage({ chatId: "room-1" })).resolves.toBeNull();
    await expect(
      adapter.listPeers({ page: 1, pageSize: 5, notInChat: "room-1" }),
    ).resolves.toEqual({
      data: [{ id: "peer-1", name: "Peer", type: "Agent", handle: null }],
      metadata: { page: 1, pageSize: 5, totalCount: 1, totalPages: 1 },
    });
    await expect(adapter.listChats({ page: 1, pageSize: 5 })).resolves.toEqual({
      data: [{ id: "room-1", title: "Room" }],
      metadata: { page: 1, pageSize: 5, totalCount: 1, totalPages: 1 },
    });
  });

  it("throws UnsupportedFeatureError when no next-message endpoint exists", async () => {
    const adapter = new FernRestAdapter({});
    await expect(adapter.getNextMessage({ chatId: "room-1" })).rejects.toBeInstanceOf(UnsupportedFeatureError);
  });
});
