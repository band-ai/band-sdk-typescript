import { describe, expect, it, vi } from "vitest";

import { RestFacade } from "../src/client/rest/RestFacade";
import type { RestApi } from "../src/client/rest/types";
import { UnsupportedFeatureError, ValidationError } from "../src/core/errors";
import { AgentTools } from "../src/runtime/tools/AgentTools";

class CoverageRestApi {
  public readonly createChatMessage = vi.fn(async () => ({ ok: true }));
  public readonly createChatEvent = vi.fn(async () => ({ ok: true }));
  public readonly createChat = vi.fn(async (taskId?: string) => ({ id: taskId ? `room-for-${taskId}` : "room-2" }));
  public readonly addChatParticipant = vi.fn(async () => ({ ok: true }));
  public readonly removeChatParticipant = vi.fn(async () => ({ ok: true }));
  public readonly listChatParticipants = vi.fn(async (): Promise<Array<{
    id: string;
    name: string;
    type: string;
    handle: string;
  }>> => []);
  public readonly listContacts = vi.fn(async (request: { page: number; pageSize: number }) => ({
    data: [],
    metadata: { page: request.page, pageSize: request.pageSize, totalCount: 0, totalPages: 0 },
  }));
  public readonly addContact = vi.fn(async (request: { handle: string; message?: string }) => ({
    ok: true,
    ...request,
  }));
  public readonly removeContact = vi.fn(async (request: { target: string; handle?: string; contactId?: string }) => ({
    ok: true,
    ...request,
  }));
  public readonly listContactRequests = vi.fn(
    async (request: { page: number; pageSize: number; sentStatus: string }) => ({
      sent: {
        data: [],
        metadata: { page: request.page, pageSize: request.pageSize, totalCount: 0, totalPages: 0 },
      },
      received: {
        data: [],
        metadata: { page: 1, pageSize: 50, totalCount: 0, totalPages: 0 },
      },
      sentStatus: request.sentStatus,
    }),
  );
  public readonly respondContactRequest = vi.fn(async (request: {
    action: string;
    target: string;
    handle?: string;
    requestId?: string;
  }) => ({
    ok: true,
    ...request,
  }));
  public readonly listPeers = vi.fn(async ({ page }: { page: number }) => {
    if (page === 1) {
      return {
        data: [{ id: "peer-1", name: "Not It", type: "Agent", handle: "@peer/not-it" }],
        metadata: { page: 1, pageSize: 100, totalCount: 2, totalPages: 2 },
      };
    }

    return {
      data: [{ id: "peer-2", name: "Target Agent", type: "Agent", handle: "@peer/target" }],
      metadata: { page: 2, pageSize: 100, totalCount: 2, totalPages: 2 },
    };
  });
  public readonly listMemories = vi.fn(async (request: Record<string, unknown>) => ({
    data: [{ id: "memory-1", content: "remembered" }],
    metadata: { page: 1, pageSize: Number(request.page_size ?? 50), totalCount: 1, totalPages: 1 },
  }));
  public readonly storeMemory = vi.fn(async (request: Record<string, unknown>) => ({
    id: "memory-2",
    ...request,
  }));
  public readonly getMemory = vi.fn(async (memoryId: string) => ({
    id: memoryId,
    content: "remembered",
  }));
  public readonly supersedeMemory = vi.fn(async (memoryId: string) => ({ ok: true, id: memoryId }));
  public readonly archiveMemory = vi.fn(async (memoryId: string) => ({ ok: true, id: memoryId }));

  public async getAgentMe() {
    return { id: "agent-1", name: "Agent", description: null };
  }

  public async markMessageProcessing() {
    return { ok: true };
  }

  public async markMessageProcessed() {
    return { ok: true };
  }

  public async markMessageFailed() {
    return { ok: true };
  }
}

function createFacade(rest: CoverageRestApi): RestFacade {
  return new RestFacade({ api: rest as unknown as RestApi });
}

describe("AgentTools coverage", () => {
  it("exposes optional adapter methods only for enabled capabilities", () => {
    const tools = new AgentTools({
      roomId: "room-1",
      rest: createFacade(new CoverageRestApi()),
      capabilities: {
        peers: true,
        contacts: false,
        memory: false,
      },
    });

    const adapterTools = tools.getAdapterTools() as unknown as Record<string, unknown>;
    expect(typeof adapterTools.lookupPeers).toBe("function");
    expect(adapterTools.listContacts).toBeUndefined();
    expect(adapterTools.listMemories).toBeUndefined();
  });

  it("paginates peer lookup when adding a participant by name", async () => {
    const rest = new CoverageRestApi();
    const tools = new AgentTools({
      roomId: "room-1",
      rest: createFacade(rest),
      capabilities: {
        peers: true,
      },
    });

    await expect(tools.addParticipant("Target Agent")).resolves.toMatchObject({
      id: "peer-2",
      name: "Target Agent",
      status: "added",
    });
    expect(rest.listPeers).toHaveBeenCalledTimes(2);
    expect(rest.addChatParticipant).toHaveBeenCalledWith(
      "room-1",
      { participantId: "peer-2", role: "member" },
      expect.any(Object),
    );
  });

  it("returns a structured validation error for invalid memory tool arguments", async () => {
    const tools = new AgentTools({
      roomId: "room-1",
      rest: createFacade(new CoverageRestApi()),
      capabilities: {
        memory: true,
      },
    });

    const result = await tools.executeToolCall("thenvoi_store_memory", {
      content: "remember this",
      thought: "reasoning",
      system: "bad-system",
      type: "bad-type",
      segment: "bad-segment",
    });

    expect(result).toMatchObject({
      ok: false,
      errorType: "ToolArgumentsValidationError",
      toolName: "thenvoi_store_memory",
      details: {
        validationErrors: expect.arrayContaining([
          expect.stringContaining("system: Invalid value 'bad-system'"),
          expect.stringContaining("type: Invalid value 'bad-type'"),
          expect.stringContaining("segment: Invalid value 'bad-segment'"),
        ]),
      },
    });
  });

  it("returns a structured execution error when a tool fails after validation passes", async () => {
    const tools = new AgentTools({
      roomId: "room-1",
      rest: createFacade(new CoverageRestApi()),
      capabilities: {
        peers: false,
      },
    });

    const result = await tools.executeToolCall("thenvoi_lookup_peers", {});

    expect(result).toMatchObject({
      ok: false,
      errorType: "ToolExecutionError",
      toolName: "thenvoi_lookup_peers",
    });
  });

  it("throws when peer lookup capability is enabled but the adapter does not support the endpoint", async () => {
    const tools = new AgentTools({
      roomId: "room-1",
      rest: new RestFacade({
        api: {
          async getAgentMe() {
            return { id: "agent-1", name: "Agent", description: null };
          },
          async createChatMessage() {
            return {};
          },
          async createChatEvent() {
            return {};
          },
          async createChat() {
            return { id: "room-2" };
          },
          async listChatParticipants() {
            return [];
          },
          async addChatParticipant() {
            return {};
          },
          async removeChatParticipant() {
            return {};
          },
          async markMessageProcessing() {
            return {};
          },
          async markMessageProcessed() {
            return {};
          },
          async markMessageFailed() {
            return {};
          },
        } as unknown as RestApi,
      }),
      capabilities: {
        peers: true,
      },
    });

    await expect(tools.lookupPeers()).rejects.toBeInstanceOf(UnsupportedFeatureError);
  });

  it("returns a structured validation error when contact tool selectors are ambiguous", async () => {
    const tools = new AgentTools({
      roomId: "room-1",
      rest: createFacade(new CoverageRestApi()),
      capabilities: {
        contacts: true,
      },
    });

    const removeResult = await tools.executeToolCall("thenvoi_remove_contact", {
      handle: "@jane",
      contact_id: "contact-1",
    });
    const respondResult = await tools.executeToolCall("thenvoi_respond_contact_request", {
      action: "approve",
      handle: "@jane",
      request_id: "request-1",
    });

    expect(removeResult).toMatchObject({
      ok: false,
      errorType: "ToolArgumentsValidationError",
      toolName: "thenvoi_remove_contact",
    });
    expect(respondResult).toMatchObject({
      ok: false,
      errorType: "ToolArgumentsValidationError",
      toolName: "thenvoi_respond_contact_request",
    });
  });

  it("includes memory tools in schemas only when memory is enabled and requested", () => {
    const toolsWithoutMemory = new AgentTools({
      roomId: "room-1",
      rest: createFacade(new CoverageRestApi()),
      capabilities: {
        memory: false,
      },
    });
    const toolsWithMemory = new AgentTools({
      roomId: "room-1",
      rest: createFacade(new CoverageRestApi()),
      capabilities: {
        memory: true,
      },
    });

    const withoutMemory = toolsWithoutMemory.getToolSchemas("openai", { includeMemory: true });
    const withMemory = toolsWithMemory.getToolSchemas("openai", { includeMemory: true });

    expect(withoutMemory.some((entry) =>
      (entry.function as { name?: string } | undefined)?.name === "thenvoi_store_memory"
    )).toBe(false);
    expect(withMemory.some((entry) =>
      (entry.function as { name?: string } | undefined)?.name === "thenvoi_store_memory"
    )).toBe(true);
  });

  it("normalizes mention objects before sending a message", async () => {
    const rest = new CoverageRestApi();
    const tools = new AgentTools({
      roomId: "room-1",
      rest: createFacade(rest),
    });

    await tools.executeToolCall("thenvoi_send_message", {
      content: "hi",
      mentions: [
        { id: "peer-1", handle: "@peer/one", name: "Peer One", username: "peer.one" },
        { id: 42, handle: "@bad" },
        null,
      ],
    });

    expect(rest.createChatMessage).toHaveBeenCalledWith(
      "room-1",
      {
        content: "hi",
        mentions: [{ id: "peer-1", handle: "@peer/one", name: "Peer One", username: "peer.one" }],
      },
      expect.any(Object),
    );
  });

  it("normalizes blank task ids when creating a chatroom through tool execution", async () => {
    const rest = new CoverageRestApi();
    const tools = new AgentTools({
      roomId: "room-1",
      rest: createFacade(rest),
    });

    await expect(
      tools.executeToolCall("thenvoi_create_chatroom", { task_id: "   " }),
    ).resolves.toBe("room-2");
    await expect(
      tools.executeToolCall("thenvoi_create_chatroom", { task_id: " task-9 " }),
    ).resolves.toBe("room-for-task-9");

    expect(rest.createChat).toHaveBeenNthCalledWith(1, undefined, expect.any(Object));
    expect(rest.createChat).toHaveBeenNthCalledWith(2, "task-9", expect.any(Object));
  });

  it("returns anthropic schemas and paginates contact endpoints with defaults", async () => {
    const rest = new CoverageRestApi();
    const tools = new AgentTools({
      roomId: "room-1",
      rest: createFacade(rest),
      capabilities: {
        contacts: true,
        memory: true,
      },
    });

    const anthropicSchemas = tools.getToolSchemas("anthropic", { includeMemory: true });
    expect(anthropicSchemas.some((entry) => entry.name === "thenvoi_store_memory")).toBe(true);
    expect(anthropicSchemas.every((entry) => "input_schema" in entry)).toBe(true);

    await tools.listContacts();
    await tools.listContactRequests();

    expect(rest.listContacts).toHaveBeenCalledWith(
      { page: 1, pageSize: 50 },
      expect.any(Object),
    );
    expect(rest.listContactRequests).toHaveBeenCalledWith(
      { page: 1, pageSize: 50, sentStatus: "pending" },
      expect.any(Object),
    );
  });

  it("returns structured validation errors for invalid event and memory query arguments", async () => {
    const tools = new AgentTools({
      roomId: "room-1",
      rest: createFacade(new CoverageRestApi()),
      capabilities: {
        memory: true,
      },
    });

    await expect(
      tools.executeToolCall("thenvoi_send_event", {
        content: "status",
        message_type: "not-real",
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorType: "ToolArgumentsValidationError",
      details: {
        validationErrors: [expect.stringContaining("message_type: Invalid value 'not-real'")],
      },
    });

    await expect(
      tools.executeToolCall("thenvoi_list_memories", {
        scope: "bad-scope",
        status: "bad-status",
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorType: "ToolArgumentsValidationError",
      message: "scope must be one of: subject, organization, all",
    });
  });

  it("resolves string mentions by id, handle, and display name after syncing participants", async () => {
    const rest = new CoverageRestApi();
    rest.listChatParticipants.mockResolvedValue([
      { id: "user-1", name: "Jane Example", type: "User", handle: "@jane" },
      { id: "agent-1", name: "Planner", type: "Agent", handle: "@team/planner" },
    ]);
    const tools = new AgentTools({
      roomId: "room-1",
      rest: createFacade(rest),
    });

    await tools.sendMessage("hi", ["user-1", "@team/planner", "Jane Example"]);

    expect(rest.createChatMessage).toHaveBeenCalledWith(
      "room-1",
      {
        content: "hi",
        mentions: [
          { id: "user-1", handle: "@jane" },
          { id: "agent-1", handle: "@team/planner" },
          { id: "user-1", handle: "@jane" },
        ],
      },
      expect.any(Object),
    );
  });

  it("validates required mentions and unknown participant mentions", async () => {
    const rest = new CoverageRestApi();
    rest.listChatParticipants.mockResolvedValue([
      { id: "user-1", name: "Jane Example", type: "User", handle: "@jane" },
    ]);
    const tools = new AgentTools({
      roomId: "room-1",
      rest: createFacade(rest),
    });

    await expect(
      tools.executeToolCall("thenvoi_send_message", {
        content: "hello",
        mentions: [],
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorType: "ToolArgumentsValidationError",
      details: {
        validationErrors: ["mentions: At least one mention is required"],
      },
    });

    await expect(tools.sendMessage("hello", ["@ghost"])).rejects.toBeInstanceOf(ValidationError);
  });

  it("covers contact methods for both selector styles", async () => {
    const rest = new CoverageRestApi();
    const tools = new AgentTools({
      roomId: "room-1",
      rest: createFacade(rest),
      capabilities: {
        contacts: true,
      },
    });

    await tools.addContact({ handle: "  @jane  ", message: "hello" });
    await tools.removeContact({ target: "handle", handle: "  @jane  " });
    await tools.removeContact({ target: "contactId", contactId: "  contact-1  " });
    await tools.respondContactRequest({ action: "approve", target: "handle", handle: "  @jane  " });
    await tools.respondContactRequest({ action: "cancel", target: "requestId", requestId: "  request-1  " });

    expect(rest.addContact).toHaveBeenCalledWith({ handle: "@jane", message: "hello" }, expect.any(Object));
    expect(rest.removeContact).toHaveBeenNthCalledWith(
      1,
      { target: "handle", handle: "@jane" },
      expect.any(Object),
    );
    expect(rest.removeContact).toHaveBeenNthCalledWith(
      2,
      { target: "contactId", contactId: "contact-1" },
      expect.any(Object),
    );
    expect(rest.respondContactRequest).toHaveBeenNthCalledWith(
      1,
      { action: "approve", target: "handle", handle: "@jane" },
      expect.any(Object),
    );
    expect(rest.respondContactRequest).toHaveBeenNthCalledWith(
      2,
      { action: "cancel", target: "requestId", requestId: "request-1" },
      expect.any(Object),
    );
  });

  it("covers memory methods and normalizes memory tool inputs", async () => {
    const rest = new CoverageRestApi();
    const tools = new AgentTools({
      roomId: "room-1",
      rest: createFacade(rest),
      capabilities: {
        memory: true,
      },
    });

    await tools.executeToolCall("thenvoi_list_memories", {
      subject_id: " subject-1 ",
      scope: "all",
      system: "working",
      type: "semantic",
      segment: "agent",
      content_query: " notes ",
      page_size: "12",
      status: "archived",
    });
    await tools.executeToolCall("thenvoi_store_memory", {
      content: " keep this ",
      thought: " because ",
      system: "working",
      type: "semantic",
      segment: "agent",
      scope: "organization",
      subject_id: " subject-1 ",
      metadata: { source: "test" },
    });
    await tools.executeToolCall("thenvoi_get_memory", { memory_id: " memory-7 " });
    await tools.executeToolCall("thenvoi_supersede_memory", { memory_id: " memory-7 " });
    await tools.executeToolCall("thenvoi_archive_memory", { memory_id: " memory-7 " });

    expect(rest.listMemories).toHaveBeenCalledWith(
      {
        subject_id: "subject-1",
        scope: "all",
        system: "working",
        type: "semantic",
        segment: "agent",
        content_query: "notes",
        page_size: 12,
        status: "archived",
      },
      expect.any(Object),
    );
    expect(rest.storeMemory).toHaveBeenCalledWith(
      {
        content: "keep this",
        thought: "because",
        system: "working",
        type: "semantic",
        segment: "agent",
        scope: "organization",
        subject_id: "subject-1",
        metadata: { source: "test" },
      },
      expect.any(Object),
    );
    expect(rest.getMemory).toHaveBeenCalledWith("memory-7", expect.any(Object));
    expect(rest.supersedeMemory).toHaveBeenCalledWith("memory-7", expect.any(Object));
    expect(rest.archiveMemory).toHaveBeenCalledWith("memory-7", expect.any(Object));
  });

  it("returns structured errors for invalid store-memory scope", async () => {
    const tools = new AgentTools({
      roomId: "room-1",
      rest: createFacade(new CoverageRestApi()),
      capabilities: {
        memory: true,
      },
    });

    await expect(
      tools.executeToolCall("thenvoi_store_memory", {
        content: "remember",
        thought: "reason",
        system: "working",
        type: "semantic",
        segment: "agent",
        scope: "bad-scope",
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorType: "ToolArgumentsValidationError",
      message: expect.stringContaining("scope must be one of: subject, organization"),
    });
  });
});
