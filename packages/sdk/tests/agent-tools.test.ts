import { describe, expect, it } from "vitest";

import { RestFacade } from "../src/client/rest/RestFacade";
import type { RestApi } from "../src/client/rest/types";
import type {
  ContactRequestAction,
  ListMemoriesArgs,
  RemoveContactArgs,
  RespondContactRequestArgs,
  StoreMemoryArgs,
} from "../src/contracts/dtos";
import {
  isToolExecutorError,
  toLegacyToolExecutorErrorMessage,
} from "../src/contracts/protocols";
import { UnsupportedFeatureError, ValidationError } from "../src/core/errors";
import { AgentTools } from "../src/runtime/tools/AgentTools";

class FakeRestApi implements RestApi {
  public readonly chatMessages: Array<{ chatId: string; content: string; mentions?: unknown[] }> = [];
  public readonly createdChats: Array<string | undefined> = [];
  public readonly addedParticipants: Array<{ chatId: string; participantId: string; role: string }> = [];
  public readonly addedContacts: Array<{ handle: string; message?: string }> = [];
  public readonly removedContacts: RemoveContactArgs[] = [];
  public readonly contactRequestResponses: RespondContactRequestArgs[] = [];
  public readonly memoryQueries: ListMemoriesArgs[] = [];
  public readonly storedMemories: StoreMemoryArgs[] = [];

  public async getAgentMe() {
    return { id: "a1", name: "Agent", description: "desc" };
  }

  public async createChatMessage(
    chatId: string,
    payload: { content: string; mentions?: unknown[] },
  ) {
    this.chatMessages.push({
      chatId,
      content: payload.content,
      mentions: payload.mentions,
    });
    return { ok: true };
  }

  public async createChatEvent() {
    return { ok: true };
  }

  public async createChat(taskId?: string) {
    this.createdChats.push(taskId);
    return { id: "r2" };
  }

  public async listChatParticipants() {
    return [
      { id: "u1", name: "Jane", type: "User", handle: "@jane" },
      { id: "u2", name: "John", type: "User", handle: "@john" },
    ];
  }

  public async addChatParticipant(
    chatId: string,
    participant: { participantId: string; role: string },
  ) {
    this.addedParticipants.push({
      chatId,
      participantId: participant.participantId,
      role: participant.role,
    });
    return { ok: true };
  }

  public async removeChatParticipant() {
    return { ok: true };
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

  public async listPeers(request: { page: number; pageSize: number }) {
    if (request.page === 1) {
      return {
        data: [{ id: "p0", name: "First", type: "Agent", handle: "@sam/first" }],
        metadata: { page: 1, pageSize: 100, totalCount: 2, totalPages: 2 },
      };
    }

    return {
      data: [{ id: "p1", name: "Weather", type: "Agent", handle: "@sam/weather" }],
      metadata: { page: 2, pageSize: 100, totalCount: 2, totalPages: 2 },
    };
  }

  public async listContacts(request: { page: number; pageSize: number }) {
    return {
      data: [{ id: "c1", handle: "jane", name: "Jane", type: "User" }],
      metadata: { page: request.page, pageSize: request.pageSize, totalCount: 1, totalPages: 1 },
    };
  }

  public async addContact(request: { handle: string; message?: string }) {
    this.addedContacts.push({ handle: request.handle, message: request.message });
    return { id: "contact-request-1", status: "pending" };
  }

  public async removeContact(request: RemoveContactArgs) {
    this.removedContacts.push(request);
    return { status: "removed" };
  }

  public async listContactRequests(request: { page: number; pageSize: number; sentStatus: string }) {
    return {
      received: [
        {
          id: "req-received-1",
          from_handle: "jane",
          from_name: "Jane",
          status: "pending",
        },
      ],
      sent: [
        {
          id: "req-sent-1",
          to_handle: "weather",
          to_name: "Weather",
          status: request.sentStatus,
        },
      ],
      metadata: {
        page: request.page,
        page_size: request.pageSize,
        received: { total: 1, total_pages: 1 },
        sent: { total: 1, total_pages: 1 },
      },
    };
  }

  public async respondContactRequest(request: RespondContactRequestArgs) {
    this.contactRequestResponses.push(request);
    const statusByAction: Record<ContactRequestAction, string> = {
      approve: "approved",
      reject: "rejected",
      cancel: "cancelled",
    };
    const id = request.target === "requestId" ? request.requestId : "req-1";
    return { id, status: statusByAction[request.action] };
  }

  public async listMemories(
    request: Parameters<NonNullable<RestApi["listMemories"]>>[0],
    _options?: Parameters<NonNullable<RestApi["listMemories"]>>[1],
  ) {
    this.memoryQueries.push(request);
    return {
      data: [{
        id: "memory-1",
        content: "Jane likes tea",
        system: "long_term" as const,
        type: "semantic" as const,
        segment: "user" as const,
      }],
      metadata: { pageSize: Number(request.page_size ?? 20), totalCount: 1 },
    };
  }

  public async storeMemory(
    request: Parameters<NonNullable<RestApi["storeMemory"]>>[0],
    _options?: Parameters<NonNullable<RestApi["storeMemory"]>>[1],
  ) {
    this.storedMemories.push(request);
    return { id: "memory-2", ...request };
  }

  public async getMemory(
    memoryId: string,
    _options?: Parameters<NonNullable<RestApi["getMemory"]>>[1],
  ) {
    return {
      id: memoryId,
      content: "Stored memory",
      system: "long_term" as const,
      type: "semantic" as const,
      segment: "user" as const,
    };
  }

  public async supersedeMemory(memoryId: string) {
    return { id: memoryId, status: "superseded" };
  }

  public async archiveMemory(memoryId: string) {
    return { id: memoryId, status: "archived" };
  }
}

describe("AgentTools", () => {
  it("sends messages with resolved mentions", async () => {
    const tools = new AgentTools({
      roomId: "room-1",
      rest: new RestFacade({ api: new FakeRestApi() }),
      participants: [{ id: "u1", handle: "@jane", name: "Jane", type: "User" }],
    });

    const result = await tools.sendMessage("hi", ["@jane"]);
    expect(result).toEqual({ ok: true });

    const resultNoAt = await tools.sendMessage("hi", ["jane"]);
    expect(resultNoAt).toEqual({ ok: true });

    const resultByName = await tools.sendMessage("hi", ["Jane"]);
    expect(resultByName).toEqual({ ok: true });
  });

  it("does not infer mentions from names or handles in message content", async () => {
    const api = new FakeRestApi();
    const tools = new AgentTools({
      roomId: "room-1",
      rest: new RestFacade({ api }),
      participants: [
        { id: "u1", handle: "@jane", name: "jane", type: "User" },
        { id: "u2", handle: "@john", name: "John", type: "User" },
      ],
    });

    await tools.sendMessage("jane is also the GitHub handle in this example.", ["@john"]);

    expect(api.chatMessages).toEqual([
      {
        chatId: "room-1",
        content: "jane is also the GitHub handle in this example.",
        mentions: [{ id: "u2" }],
      },
    ]);
  });

  it("gates peers endpoint when disabled", async () => {
    const tools = new AgentTools({
      roomId: "room-1",
      rest: new RestFacade({ api: new FakeRestApi() }),
      capabilities: { peers: false },
    });

    await expect(tools.lookupPeers()).rejects.toBeInstanceOf(UnsupportedFeatureError);
  });

  it("includes lookup tool schema only when peers enabled", () => {
    const tools = new AgentTools({
      roomId: "room-1",
      rest: new RestFacade({ api: new FakeRestApi() }),
      capabilities: { peers: false },
    });

    const schemas = tools.getToolSchemas("openai");
    const hasLookup = schemas.some(
      (entry) => (entry.function as { name?: string } | undefined)?.name === "thenvoi_lookup_peers",
    );
    expect(hasLookup).toBe(false);
  });

  it("validates event message type", async () => {
    const tools = new AgentTools({
      roomId: "room-1",
      rest: new RestFacade({ api: new FakeRestApi() }),
    });

    await expect(tools.sendEvent("hello", "message_created")).rejects.toBeInstanceOf(ValidationError);
  });

  it("validates send_message requires mentions", async () => {
    const tools = new AgentTools({
      roomId: "room-1",
      rest: new RestFacade({ api: new FakeRestApi() }),
    });

    const result = await tools.executeToolCall("thenvoi_send_message", {
      content: "hello",
      mentions: [],
    });
    expect(isToolExecutorError(result)).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      errorType: "ToolArgumentsValidationError",
      toolName: "thenvoi_send_message",
    });
    expect(toLegacyToolExecutorErrorMessage(result)).toContain("Invalid arguments for thenvoi_send_message");
    expect(toLegacyToolExecutorErrorMessage(result)).toContain("mentions: At least one mention is required");
  });

  it("validates send_message requires content field", async () => {
    const tools = new AgentTools({
      roomId: "room-1",
      rest: new RestFacade({ api: new FakeRestApi() }),
    });

    const result = await tools.executeToolCall("thenvoi_send_message", {
      mentions: ["@jane"],
    });
    expect(isToolExecutorError(result)).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      errorType: "ToolArgumentsValidationError",
      toolName: "thenvoi_send_message",
    });
    expect(toLegacyToolExecutorErrorMessage(result)).toContain("Invalid arguments for thenvoi_send_message");
    expect(toLegacyToolExecutorErrorMessage(result)).toContain("content: Field required");
  });

  it("validates send_event rejects invalid message_type", async () => {
    const tools = new AgentTools({
      roomId: "room-1",
      rest: new RestFacade({ api: new FakeRestApi() }),
    });

    const result = await tools.executeToolCall("thenvoi_send_event", {
      content: "hello",
      message_type: "invalid_type",
    });
    expect(isToolExecutorError(result)).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      errorType: "ToolArgumentsValidationError",
      toolName: "thenvoi_send_event",
    });
    expect(toLegacyToolExecutorErrorMessage(result)).toContain("Invalid arguments for thenvoi_send_event");
    expect(toLegacyToolExecutorErrorMessage(result)).toContain("message_type: Invalid value");
  });

  it("wraps execution errors as LLM-friendly strings", async () => {
    const tools = new AgentTools({
      roomId: "room-1",
      rest: new RestFacade({ api: new FakeRestApi() }),
      participants: [],
    });

    const result = await tools.executeToolCall("thenvoi_send_message", {
      content: "hello",
      mentions: ["@nonexistent"],
    });
    expect(isToolExecutorError(result)).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      errorType: "ToolArgumentsValidationError",
      toolName: "thenvoi_send_message",
    });
    expect(toLegacyToolExecutorErrorMessage(result)).toContain("Invalid arguments for thenvoi_send_message");
  });

  it("returns error string for unknown tools", async () => {
    const tools = new AgentTools({
      roomId: "room-1",
      rest: new RestFacade({ api: new FakeRestApi() }),
    });

    const result = await tools.executeToolCall("unknown_tool", {});
    expect(isToolExecutorError(result)).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      errorType: "ToolNotFoundError",
      toolName: "unknown_tool",
    });
    expect(toLegacyToolExecutorErrorMessage(result)).toBe("Unknown tool: unknown_tool");
  });

  it("looks up peers across paginated pages when adding participant", async () => {
    const api = new FakeRestApi();
    const tools = new AgentTools({
      roomId: "room-1",
      rest: new RestFacade({ api }),
      capabilities: { peers: true },
    });

    const result = await tools.addParticipant("Weather");
    expect(result).toMatchObject({ id: "p1", name: "Weather", status: "added" });
    expect(api.addedParticipants).toEqual([
      { chatId: "room-1", participantId: "p1", role: "member" },
    ]);
  });

  it("delegates contact tools to the REST adapter when enabled", async () => {
    const api = new FakeRestApi();
    const tools = new AgentTools({
      roomId: "room-1",
      rest: new RestFacade({ api }),
      capabilities: { contacts: true },
    });

    await expect(tools.listContacts({ page: 2, pageSize: 25 })).resolves.toEqual({
      data: [{ id: "c1", handle: "jane", name: "Jane", type: "User" }],
      metadata: { page: 2, pageSize: 25, totalCount: 1, totalPages: 1 },
    });
    await expect(tools.addContact({ handle: " @jane ", message: "hello" })).resolves.toEqual({
      id: "contact-request-1",
      status: "pending",
    });
    await expect(tools.removeContact({ target: "contactId", contactId: " contact-1 " })).resolves.toEqual({
      status: "removed",
    });
    await expect(tools.listContactRequests({ page: 1, pageSize: 10, sentStatus: "approved" })).resolves.toMatchObject({
      received: [{ id: "req-received-1", from_handle: "jane" }],
      sent: [{ id: "req-sent-1", status: "approved" }],
    });
    await expect(tools.respondContactRequest({
      action: "approve",
      target: "requestId",
      requestId: " req-received-1 ",
    })).resolves.toEqual({
      id: "req-received-1",
      status: "approved",
    });

    expect(api.addedContacts).toEqual([{ handle: "@jane", message: "hello" }]);
    expect(api.removedContacts).toEqual([{ target: "contactId", contactId: "contact-1" }]);
    expect(api.contactRequestResponses).toEqual([
      { action: "approve", target: "requestId", requestId: "req-received-1" },
    ]);
  });

  it("delegates memory tools to the REST adapter when enabled", async () => {
    const api = new FakeRestApi();
    const tools = new AgentTools({
      roomId: "room-1",
      rest: new RestFacade({ api }),
      capabilities: { memory: true },
    });

    await expect(
      tools.listMemories({ subject_id: " user-1 ", page_size: 5, scope: "subject" }),
    ).resolves.toEqual({
      data: [{ id: "memory-1", content: "Jane likes tea", system: "long_term", type: "semantic", segment: "user" }],
      metadata: { pageSize: 5, totalCount: 1 },
    });
    await expect(
      tools.storeMemory({
        content: "  Jane prefers tea  ",
        system: "long_term",
        type: "semantic",
        segment: "user",
        thought: "  Important preference  ",
        subject_id: " user-1 ",
      }),
    ).resolves.toMatchObject({
      id: "memory-2",
      content: "  Jane prefers tea  ",
      subject_id: " user-1 ",
    });
    await expect(tools.getMemory(" memory-2 ")).resolves.toMatchObject({ id: "memory-2" });
    await expect(tools.supersedeMemory(" memory-2 ")).resolves.toEqual({
      id: "memory-2",
      status: "superseded",
    });
    await expect(tools.archiveMemory(" memory-2 ")).resolves.toEqual({
      id: "memory-2",
      status: "archived",
    });

    expect(api.memoryQueries).toEqual([{ subject_id: " user-1 ", page_size: 5, scope: "subject" }]);
    expect(api.storedMemories).toEqual([
      {
        content: "  Jane prefers tea  ",
        system: "long_term",
        type: "semantic",
        segment: "user",
        thought: "  Important preference  ",
        subject_id: " user-1 ",
      },
    ]);
  });

  it("validates required contact and memory identifiers before delegating", async () => {
    const tools = new AgentTools({
      roomId: "room-1",
      rest: new RestFacade({ api: new FakeRestApi() }),
      capabilities: { contacts: true, memory: true },
    });

    await expect(tools.removeContact({ target: "contactId", contactId: "   " })).rejects.toThrow(
      "contactId is required",
    );
    await expect(tools.respondContactRequest({
      action: "approve",
      target: "requestId",
      requestId: "   ",
    })).rejects.toThrow("requestId is required");
    await expect(tools.getMemory("   ")).rejects.toThrow("memoryId is required");
  });

  it("normalizes mention objects and task ids through tool execution", async () => {
    const api = new FakeRestApi();
    const tools = new AgentTools({
      roomId: "room-1",
      rest: new RestFacade({ api }),
      participants: [{ id: "u1", handle: "@jane", name: "Jane", type: "User" }],
    });

    await expect(
      tools.executeToolCall("thenvoi_send_message", {
        content: "hello",
        mentions: [
          { id: "u1", handle: "@jane", name: "Jane", username: "jane" },
          { nope: true },
          "ignored",
        ],
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      tools.executeToolCall("thenvoi_create_chatroom", {
        task_id: "  task-123  ",
      }),
    ).resolves.toBe("r2");

    expect(api.chatMessages).toEqual([
      {
        chatId: "room-1",
        content: "hello",
        mentions: [{ id: "u1" }],
      },
    ]);
    expect(api.createdChats).toEqual(["task-123"]);
  });

  it("supports anthropic schemas and extra contact and memory execution branches", async () => {
    const api = new FakeRestApi();
    const tools = new AgentTools({
      roomId: "room-1",
      rest: new RestFacade({ api }),
      capabilities: { contacts: true, memory: true },
    });

    const schemas = tools.getToolSchemas("anthropic", { includeMemory: true });

    await expect(
      tools.executeToolCall("thenvoi_remove_contact", {
        handle: "  @jane  ",
      }),
    ).resolves.toEqual({ status: "removed" });
    await expect(
      tools.executeToolCall("thenvoi_respond_contact_request", {
        action: "cancel",
        handle: "  weather  ",
      }),
    ).resolves.toEqual({
      id: "req-1",
      status: "cancelled",
    });
    await expect(
      tools.executeToolCall("thenvoi_list_memories", {
        page_size: "7",
        scope: "all",
        system: "working",
        type: "semantic",
        segment: "guideline",
        status: "archived",
        content_query: "  tea  ",
      }),
    ).resolves.toMatchObject({
      metadata: { pageSize: 7 },
    });
    await expect(
      tools.executeToolCall("thenvoi_store_memory", {
        content: "remember",
        thought: "because",
        system: "working",
        type: "semantic",
        segment: "guideline",
        scope: "organization",
        metadata: { source: "test" },
      }),
    ).resolves.toMatchObject({
      content: "remember",
      scope: "organization",
    });

    expect(schemas.some((entry) => entry.name === "thenvoi_store_memory")).toBe(true);
    expect(api.removedContacts).toContainEqual({ target: "handle", handle: "@jane" });
    expect(api.contactRequestResponses).toContainEqual({
      action: "cancel",
      target: "handle",
      handle: "weather",
    });
    expect(api.memoryQueries).toContainEqual({
      page_size: 7,
      scope: "all",
      system: "working",
      type: "semantic",
      segment: "guideline",
      status: "archived",
      content_query: "tea",
    });
    expect(api.storedMemories).toContainEqual({
      content: "remember",
      thought: "because",
      system: "working",
      type: "semantic",
      segment: "guideline",
      scope: "organization",
      metadata: { source: "test" },
    });
  });

  it("reports validation errors for bad contact and memory tool arguments", async () => {
    const tools = new AgentTools({
      roomId: "room-1",
      rest: new RestFacade({ api: new FakeRestApi() }),
      capabilities: { contacts: true, memory: true },
    });

    await expect(
      tools.executeToolCall("thenvoi_respond_contact_request", {
        action: "wave",
        request_id: "req-1",
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorType: "ToolArgumentsValidationError",
      toolName: "thenvoi_respond_contact_request",
    });
    await expect(
      tools.executeToolCall("thenvoi_list_memories", {
        status: "bad-status",
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorType: "ToolArgumentsValidationError",
      toolName: "thenvoi_list_memories",
    });
    await expect(
      tools.executeToolCall("thenvoi_store_memory", {
        content: "remember",
        thought: "because",
        system: "working",
        type: "semantic",
        segment: "guideline",
        scope: "bad-scope",
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorType: "ToolArgumentsValidationError",
      toolName: "thenvoi_store_memory",
    });
  });
});
