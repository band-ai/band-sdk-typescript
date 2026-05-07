import { describe, expect, it, vi } from "vitest";

import { GenericAdapter } from "../src/adapters/GenericAdapter";
import { FernRestAdapter, RestFacade } from "../src/client/rest/RestFacade";
import { ValidationError } from "../src/core/errors";
import { PlatformRuntime } from "../src/runtime/PlatformRuntime";
import { ExecutionContext } from "../src/runtime/ExecutionContext";
import { HUB_ROOM_SYSTEM_PROMPT } from "../src/runtime/ContactEventHandler";
import type { StreamingTransport, TopicHandlers } from "../src/platform/streaming/transport";
import { ThenvoiLink } from "../src/platform/ThenvoiLink";
import { FakeRestApi } from "./testUtils";

class FakeTransport implements StreamingTransport {
  private handlers = new Map<string, TopicHandlers>();
  private connected = false;

  public async connect() {
    this.connected = true;
  }

  public async disconnect() {
    this.connected = false;
  }

  public async join(topic: string, handlers: TopicHandlers) {
    this.handlers.set(topic, handlers);
  }

  public async leave(topic: string) {
    this.handlers.delete(topic);
  }

  public async runForever(signal?: AbortSignal): Promise<void> {
    if (!signal) {
      return;
    }
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  }

  public isConnected() {
    return this.connected;
  }

  public async emit(topic: string, event: string, payload: Record<string, unknown>): Promise<void> {
    const topicHandlers = this.handlers.get(topic);
    if (!topicHandlers?.[event]) {
      throw new Error(`No handler for ${topic}/${event}`);
    }

    await Promise.resolve(topicHandlers[event](payload));
  }

  public hasTopic(topic: string): boolean {
    return this.handlers.has(topic);
  }
}

describe("PlatformRuntime", () => {
  it("initializes and dispatches message to adapter", async () => {
    const transport = new FakeTransport();
    const lifecycle: string[] = [];
    const markAwareRest = new FakeRestApi(
      {
        markMessageProcessing: async (_chatId, _messageId) => {
          lifecycle.push("processing");
          return {};
        },
        markMessageProcessed: async (_chatId, _messageId) => {
          lifecycle.push("processed");
          return {};
        },
        markMessageFailed: async () => {
          lifecycle.push("failed");
          return {};
        },
      },
      {
        id: "a1",
        name: "Agent",
        description: "Agent description",
      },
    );

    let seenMessage = "";
    let resolveSeen: (() => void) | null = null;
    const seenPromise = new Promise<void>((resolve) => {
      resolveSeen = resolve;
    });
    const adapter = new GenericAdapter(async ({ message }) => {
      lifecycle.push("adapter");
      seenMessage = message.content;
      resolveSeen?.();
    });

    const runtime = new PlatformRuntime({
      agentId: "a1",
      apiKey: "k",
      link: new ThenvoiLink({
        agentId: "a1",
        apiKey: "k",
        transport,
        restApi: markAwareRest,
      }),
    });

    await runtime.start(adapter);

    await transport.emit("agent_rooms:a1", "room_added", { id: "room-1", status: "active", type: "direct", title: "Room", removed_at: "" });
    await transport.emit("chat_room:room-1", "message_created", {
      id: "m1",
      content: "hello runtime",
      message_type: "text",
      sender_id: "u1",
      sender_type: "User",
      sender_name: "Jane",
      inserted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    await seenPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runtime.name).toBe("Agent");
    expect(seenMessage).toBe("hello runtime");
    expect(lifecycle).toEqual(["processing", "adapter", "processed"]);

    await runtime.stop();
  });

  it("exposes fern adapter for duck-typed client", async () => {
    const adapter = new FernRestAdapter({
      agentApiIdentity: {
        getAgentMe: async () => ({
          data: {
            id: "a1",
            name: "Agent",
            description: null,
            owner_uuid: "owner-1",
          },
        }),
      },
      agentApiMessages: {
        createAgentChatMessage: async () => ({ ok: true }),
        markAgentMessageProcessing: async () => ({ ok: true }),
        markAgentMessageProcessed: async () => ({ ok: true }),
        markAgentMessageFailed: async () => ({ ok: true }),
      },
      agentApiChats: {
        createAgentChat: async () => ({ data: { id: "room-1" } }),
      },
      agentApiParticipants: {
        listAgentChatParticipants: async () => ({ data: [] }),
        addAgentChatParticipant: async () => ({ ok: true }),
        removeAgentChatParticipant: async () => ({ ok: true }),
      },
    });

    const rest = new RestFacade({ api: adapter });
    await expect(rest.getAgentMe()).resolves.toEqual({
      id: "a1",
      name: "Agent",
      description: null,
      handle: null,
      ownerUuid: "owner-1",
    });
  });

  it("auto-subscribes existing rooms and unsubscribes on room_deleted", async () => {
    const transport = new FakeTransport();
    const restApi = new FakeRestApi({
      listChats: async () => ({
        data: [{ id: "room-existing", title: "Existing Room" }],
        metadata: { page: 1, pageSize: 100, totalPages: 1, totalCount: 1 },
      }),
    });
    const seenMessages: string[] = [];

    const adapter = new GenericAdapter(async ({ message }) => {
      seenMessages.push(message.content);
    });

    const runtime = new PlatformRuntime({
      agentId: "a1",
      apiKey: "k",
      link: new ThenvoiLink({
        agentId: "a1",
        apiKey: "k",
        transport,
        restApi,
      }),
      agentConfig: {
        autoSubscribeExistingRooms: true,
      },
    });

    await runtime.start(adapter);

    expect(transport.hasTopic("chat_room:room-existing")).toBe(true);
    expect(transport.hasTopic("room_participants:room-existing")).toBe(true);

    await transport.emit("chat_room:room-existing", "message_created", {
      id: "m1",
      content: "hello existing",
      message_type: "text",
      sender_id: "u1",
      sender_type: "User",
      sender_name: "Jane",
      inserted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(seenMessages).toEqual(["hello existing"]);

    await transport.emit("room_participants:room-existing", "room_deleted", {
      id: "room-existing",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transport.hasTopic("chat_room:room-existing")).toBe(false);
    expect(transport.hasTopic("room_participants:room-existing")).toBe(false);

    await runtime.stop();
  });

  it("skips rooms rejected by roomFilter", async () => {
    const transport = new FakeTransport();
    const adapter = new GenericAdapter(async () => {});

    const runtime = new PlatformRuntime({
      agentId: "a1",
      apiKey: "k",
      link: new ThenvoiLink({
        agentId: "a1",
        apiKey: "k",
        transport,
        restApi: new FakeRestApi(),
      }),
      roomFilter: (room) => room.type !== "group",
    });

    await runtime.start(adapter);

    await transport.emit("agent_rooms:a1", "room_added", {
      id: "direct-1",
      status: "active",
      type: "direct",
      title: "Direct",
      removed_at: "",
    });
    await transport.emit("agent_rooms:a1", "room_added", {
      id: "group-1",
      status: "active",
      type: "group",
      title: "Group",
      removed_at: "",
    });

    expect(transport.hasTopic("chat_room:direct-1")).toBe(true);
    expect(transport.hasTopic("chat_room:group-1")).toBe(false);

    await runtime.stop();
  });

  it("uses contextFactory when provided", async () => {
    const transport = new FakeTransport();
    const factoryCalls: string[] = [];
    const adapter = new GenericAdapter(async () => {});

    const runtime = new PlatformRuntime({
      agentId: "a1",
      apiKey: "k",
      link: new ThenvoiLink({
        agentId: "a1",
        apiKey: "k",
        transport,
        restApi: new FakeRestApi(),
      }),
      contextFactory: (roomId, defaults) => {
        factoryCalls.push(roomId);
        return new ExecutionContext(defaults);
      },
    });

    await runtime.start(adapter);

    await transport.emit("agent_rooms:a1", "room_added", {
      id: "room-1",
      status: "active",
      type: "direct",
      title: "Room",
      removed_at: "",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(factoryCalls).toEqual(["room-1"]);

    await runtime.stop();
  });

  it("propagates fatal adapter failures through runForever", async () => {
    const transport = new FakeTransport();
    const adapter = new GenericAdapter(async () => {
      throw new Error("adapter exploded");
    });

    const runtime = new PlatformRuntime({
      agentId: "a1",
      apiKey: "k",
      link: new ThenvoiLink({
        agentId: "a1",
        apiKey: "k",
        transport,
        restApi: new FakeRestApi(),
      }),
    });

    await runtime.start(adapter);
    const runPromise = runtime.runForever();

    await transport.emit("agent_rooms:a1", "room_added", {
      id: "room-1",
      status: "active",
      type: "direct",
      title: "Room",
      removed_at: "",
    });
    await transport.emit("chat_room:room-1", "message_created", {
      id: "m-fail",
      content: "explode",
      message_type: "text",
      sender_id: "u1",
      sender_type: "User",
      sender_name: "Jane",
      inserted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    await expect(runPromise).rejects.toThrow("adapter exploded");
  });

  it("synchronizes existing rooms via /messages/next and skips the sync-point websocket duplicate", async () => {
    const transport = new FakeTransport();
    let releaseSync!: () => void;
    const syncGate = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const backlog = [
      {
        id: "m-backlog",
        content: "recover me first",
        sender_id: "u1",
        sender_type: "User",
        sender_name: "Jane",
        message_type: "text",
        metadata: {},
        inserted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: "m-sync",
        content: "recover me second",
        sender_id: "u1",
        sender_type: "User",
        sender_name: "Jane",
        message_type: "text",
        metadata: {},
        inserted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];
    const restApi = new FakeRestApi({
      listChats: async () => ({
        data: [{ id: "room-existing", title: "Existing Room" }],
        metadata: { page: 1, pageSize: 100, totalPages: 1, totalCount: 1 },
      }),
      getNextMessage: async () => {
        await syncGate;
        return backlog.shift() ?? null;
      },
    });
    const seenMessages: string[] = [];

    const adapter = new GenericAdapter(async ({ message }) => {
      seenMessages.push(message.content);
    });

    const runtime = new PlatformRuntime({
      agentId: "a1",
      apiKey: "k",
      link: new ThenvoiLink({
        agentId: "a1",
        apiKey: "k",
        transport,
        restApi,
      }),
      agentConfig: {
        autoSubscribeExistingRooms: true,
      },
    });

    await runtime.start(adapter);

    await transport.emit("chat_room:room-existing", "message_created", {
      id: "m-sync",
      content: "recover me second",
      message_type: "text",
      sender_id: "u1",
      sender_type: "User",
      sender_name: "Jane",
      inserted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    await transport.emit("chat_room:room-existing", "message_created", {
      id: "m-live",
      content: "live only",
      message_type: "text",
      sender_id: "u1",
      sender_type: "User",
      sender_name: "Jane",
      inserted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    releaseSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(seenMessages).toEqual([
      // Auto-subscribed existing rooms no longer pre-poll /messages/next at
      // startup (skipStartupCatchup=true on the rehydrate path), so the
      // backlog "m-backlog" / "recover me first" returned by the mocked
      // getStaleProcessingMessages stays untouched. The two messages still
      // delivered ("m-sync" and "m-live") are both live WebSocket
      // notifications that bypass the startup REST polls. Crash-recovery
      // for in-flight `processing` messages still runs separately via the
      // explicit bootstrapMessage / room_added paths.
      "recover me second",
      "live only",
    ]);

    await runtime.stop();
  });

  it("preserves the hub-room system prompt on the first contact event", async () => {
    const transport = new FakeTransport();
    const restApi = new FakeRestApi({
      createChat: async () => ({ id: "hub-room-1" }),
      createChatEvent: async () => ({}),
    });
    let resolveSeen: (() => void) | null = null;
    const seenPromise = new Promise<void>((resolve) => {
      resolveSeen = resolve;
    });
    const seenInputs: Array<{ contactsMessage: string | null; content: string }> = [];
    const adapter = new GenericAdapter(async ({ message, contactsMessage }) => {
      seenInputs.push({
        contactsMessage,
        content: message.content,
      });
      resolveSeen?.();
    });

    const runtime = new PlatformRuntime({
      agentId: "a1",
      apiKey: "k",
      link: new ThenvoiLink({
        agentId: "a1",
        apiKey: "k",
        transport,
        restApi,
      }),
      contactConfig: {
        strategy: "hub_room",
        hubTaskId: "task-1",
      },
    });

    await runtime.start(adapter);

    await transport.emit("agent_contacts:a1", "contact_request_received", {
      id: "req-1",
      from_handle: "alice",
      from_name: "Alice",
      message: "Hello!",
      status: "pending",
      inserted_at: new Date().toISOString(),
    });

    await seenPromise;

    expect(seenInputs).toEqual([
      {
        contactsMessage: HUB_ROOM_SYSTEM_PROMPT,
        content: "[Contact Request] Alice (@alice) wants to connect.\nMessage: \"Hello!\"\nRequest ID: req-1",
      },
    ]);

    await runtime.stop();
  });

  it("calls adapter onRuntimeStop when PlatformRuntime stops", async () => {
    const transport = new FakeTransport();
    const adapter = {
      onEvent: vi.fn(async () => undefined),
      onCleanup: vi.fn(async () => undefined),
      onStarted: vi.fn(async () => undefined),
      onRuntimeStop: vi.fn(async () => undefined),
    };

    const runtime = new PlatformRuntime({
      agentId: "a1",
      apiKey: "k",
      link: new ThenvoiLink({
        agentId: "a1",
        apiKey: "k",
        transport,
        restApi: new FakeRestApi(),
      }),
    });

    await runtime.start(adapter);
    await runtime.stop();

    expect(adapter.onRuntimeStop).toHaveBeenCalledTimes(1);
  });

  it("cleans up adapter runtime hooks when startup fails after onStarted", async () => {
    const adapter = {
      onEvent: vi.fn(async () => undefined),
      onCleanup: vi.fn(async () => undefined),
      onStarted: vi.fn(async () => undefined),
      onRuntimeStop: vi.fn(async () => undefined),
    };
    const transport: StreamingTransport = {
      connect: vi.fn(async () => {
        throw new Error("connect failed");
      }),
      disconnect: vi.fn(async () => undefined),
      join: vi.fn(async () => undefined),
      leave: vi.fn(async () => undefined),
      runForever: vi.fn(async () => undefined),
      isConnected: vi.fn(() => false),
    };

    const runtime = new PlatformRuntime({
      agentId: "a1",
      apiKey: "k",
      link: new ThenvoiLink({
        agentId: "a1",
        apiKey: "k",
        transport,
        restApi: new FakeRestApi(),
      }),
    });

    await expect(runtime.start(adapter)).rejects.toThrow("connect failed");

    expect(adapter.onStarted).toHaveBeenCalledTimes(1);
    expect(adapter.onRuntimeStop).toHaveBeenCalledTimes(1);
  });

  it("throws ValidationError when agentId is empty", () => {
    expect(
      () => new PlatformRuntime({ agentId: "", apiKey: "valid-key" }),
    ).toThrow(ValidationError);
    expect(
      () => new PlatformRuntime({ agentId: "", apiKey: "valid-key" }),
    ).toThrow("agentId is required");
  });

  it("throws ValidationError when agentId is whitespace-only", () => {
    expect(
      () => new PlatformRuntime({ agentId: "  ", apiKey: "valid-key" }),
    ).toThrow(ValidationError);
  });

  it("throws ValidationError when apiKey is empty", () => {
    expect(
      () => new PlatformRuntime({ agentId: "valid-id", apiKey: "" }),
    ).toThrow(ValidationError);
    expect(
      () => new PlatformRuntime({ agentId: "valid-id", apiKey: "" }),
    ).toThrow("apiKey is required");
  });

  it("throws ValidationError when apiKey is whitespace-only", () => {
    expect(
      () => new PlatformRuntime({ agentId: "valid-id", apiKey: "   " }),
    ).toThrow(ValidationError);
  });

  it("validation error message mentions loadAgentConfig", () => {
    expect(
      () => new PlatformRuntime({ agentId: "", apiKey: "valid-key" }),
    ).toThrow("loadAgentConfig()");
  });

  it("forwards logger to lazily-constructed ThenvoiLink", async () => {
    const spyLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const transport = new FakeTransport();
    const restApi = new FakeRestApi();

    const runtime = new PlatformRuntime({
      agentId: "a1",
      apiKey: "k",
      wsUrl: "wss://example.test/socket",
      logger: spyLogger,
      linkOptions: { transport, restApi },
    });

    await runtime.initialize();

    expect((runtime.link as unknown as { logger: unknown }).logger).toBe(spyLogger);
  });
});
