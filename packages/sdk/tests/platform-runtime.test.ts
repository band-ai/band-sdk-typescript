import { describe, expect, it, vi } from "vitest";

import { GenericAdapter } from "../src/adapters/GenericAdapter";
import { FernRestAdapter, RestFacade } from "../src/client/rest/RestFacade";
import { TransportError, ValidationError } from "../src/core/errors";
import { PlatformRuntime } from "../src/runtime/PlatformRuntime";
import { ExecutionContext } from "../src/runtime/ExecutionContext";
import { HUB_ROOM_SYSTEM_PROMPT } from "../src/runtime/ContactEventHandler";
import type { StreamingTransport } from "../src/platform/streaming/transport";
import { BandLink } from "../src/platform/BandLink";
import { FakeRestApi, FakeTransport, makeMessage } from "./testUtils";

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

    await using runtime = new PlatformRuntime({
      agentId: "a1",
      apiKey: "k",
      link: new BandLink({
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

    await using runtime = new PlatformRuntime({
      agentId: "a1",
      apiKey: "k",
      link: new BandLink({
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
  });

  it("skips rooms rejected by roomFilter", async () => {
    const transport = new FakeTransport();
    const adapter = new GenericAdapter(async () => {});

    await using runtime = new PlatformRuntime({
      agentId: "a1",
      apiKey: "k",
      link: new BandLink({
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
  });

  it("uses contextFactory when provided", async () => {
    const transport = new FakeTransport();
    const factoryCalls: string[] = [];
    const adapter = new GenericAdapter(async () => {});

    await using runtime = new PlatformRuntime({
      agentId: "a1",
      apiKey: "k",
      link: new BandLink({
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
  });

  it("dispatches participant events to the room context and message events to its execution", async () => {
    const transport = new FakeTransport();
    const added: string[] = [];
    const removed: string[] = [];
    const seenMessages: string[] = [];

    const adapter = new GenericAdapter(async ({ message }) => {
      seenMessages.push(message.content);
    });

    await using runtime = new PlatformRuntime({
      agentId: "a1",
      apiKey: "k",
      link: new BandLink({
        agentId: "a1",
        apiKey: "k",
        transport,
        restApi: new FakeRestApi(),
      }),
      onParticipantAdded: (roomId, participant) => {
        added.push(`${roomId}:${String(participant.id)}`);
      },
      onParticipantRemoved: (roomId, participantId) => {
        removed.push(`${roomId}:${participantId}`);
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
    // Admission joins `chat_room` then `room_participants` sequentially
    // (BandLink.joinRoomTopics), so both topics need a tick to settle
    // before either can be driven.
    await new Promise((resolve) => setTimeout(resolve, 0));

    await transport.emit("room_participants:room-1", "participant_added", {
      id: "participant-1",
      name: "Jane",
      type: "User",
      handle: "jane",
    });
    await transport.emit("chat_room:room-1", "message_created", {
      id: "m1",
      content: "hello",
      message_type: "text",
      sender_id: "u1",
      sender_type: "User",
      sender_name: "Jane",
      inserted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    await transport.emit("room_participants:room-1", "participant_removed", {
      id: "participant-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(added).toEqual(["room-1:participant-1"]);
    expect(seenMessages).toEqual(["hello"]);
    expect(removed).toEqual(["room-1:participant-1"]);
  });

  it("cleans up admitted rooms via onCleanup when the runtime stops, without a prior room_removed", async () => {
    const transport = new FakeTransport();
    const adapter = {
      onEvent: vi.fn(async () => undefined),
      onCleanup: vi.fn(async () => undefined),
      onStarted: vi.fn(async () => undefined),
      onRuntimeStop: vi.fn(async () => undefined),
    };

    await using runtime = new PlatformRuntime({
      agentId: "a1",
      apiKey: "k",
      link: new BandLink({
        agentId: "a1",
        apiKey: "k",
        transport,
        restApi: new FakeRestApi(),
      }),
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

    await runtime.stop();

    expect(adapter.onCleanup).toHaveBeenCalledWith("room-1");
  });

  it("throws when bootstrapRoomMessage's room subscribe fails, and leaves the topic unjoined", async () => {
    const transport = new FakeTransport();
    const adapter = new GenericAdapter(async () => {});

    await using runtime = new PlatformRuntime({
      agentId: "a1",
      apiKey: "k",
      link: new BandLink({
        agentId: "a1",
        apiKey: "k",
        transport,
        restApi: new FakeRestApi(),
      }),
    });

    await runtime.start(adapter);

    vi.spyOn(transport, "join").mockRejectedValueOnce(new Error("join failed"));

    await expect(
      runtime.bootstrapRoomMessage("room-bootstrap", makeMessage("hello", "room-bootstrap")),
    ).rejects.toThrow(TransportError);

    await expect(transport.emit("chat_room:room-bootstrap", "message_created", {})).rejects.toThrow(
      "No handler for chat_room:room-bootstrap/message_created",
    );
  });

  it("propagates fatal adapter failures through runForever", async () => {
    const transport = new FakeTransport();
    const adapter = new GenericAdapter(async () => {
      throw new Error("adapter exploded");
    });

    const runtime = new PlatformRuntime({
      agentId: "a1",
      apiKey: "k",
      link: new BandLink({
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

    await using runtime = new PlatformRuntime({
      agentId: "a1",
      apiKey: "k",
      link: new BandLink({
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
      "recover me first",
      "recover me second",
      "live only",
    ]);
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

    await using runtime = new PlatformRuntime({
      agentId: "a1",
      apiKey: "k",
      link: new BandLink({
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
  });

  it("calls adapter onRuntimeStop when PlatformRuntime stops", async () => {
    const transport = new FakeTransport();
    const adapter = {
      onEvent: vi.fn(async () => undefined),
      onCleanup: vi.fn(async () => undefined),
      onStarted: vi.fn(async () => undefined),
      onRuntimeStop: vi.fn(async () => undefined),
    };

    await using runtime = new PlatformRuntime({
      agentId: "a1",
      apiKey: "k",
      link: new BandLink({
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

    await using runtime = new PlatformRuntime({
      agentId: "a1",
      apiKey: "k",
      link: new BandLink({
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

  it("forwards logger to lazily-constructed BandLink", async () => {
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
