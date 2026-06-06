import { describe, expect, it } from "vitest";

import { A2AGatewayAdapter } from "../src/adapters/a2a-gateway/A2AGatewayAdapter";
import type {
  GatewayRequest,
  GatewayServerFactory,
  GatewayServerLike,
} from "../src/adapters/a2a-gateway/types";
import type {
  ChatMessageMention,
  ChatParticipant,
  RestApi,
} from "../src/client/rest/types";
import { FakeTools, makeMessage } from "./testUtils";

class FakeRestApi implements RestApi {
  public readonly createChatCalls: string[] = [];
  public readonly addParticipantCalls: Array<{
    chatId: string;
    participantId: string;
  }> = [];
  public readonly createMessageCalls: Array<{
    chatId: string;
    content: string;
    mentions?: ChatMessageMention[];
    metadata?: Record<string, unknown>;
  }> = [];
  public readonly createEventCalls: Array<{
    chatId: string;
    metadata?: Record<string, unknown>;
  }> = [];

  public async getAgentMe() {
    return {
      id: "gateway-agent",
      name: "Gateway Agent",
      description: "A2A gateway",
    };
  }

  public async createChatMessage(
    chatId: string,
    message: {
      content: string;
      messageType?: string;
      metadata?: Record<string, unknown>;
      mentions?: ChatMessageMention[];
    },
  ): Promise<Record<string, unknown>> {
    this.createMessageCalls.push({
      chatId,
      content: message.content,
      mentions: message.mentions,
      metadata: message.metadata,
    });
    return { id: `msg-${this.createMessageCalls.length}` };
  }

  public async createChatEvent(
    chatId: string,
    event: {
      content: string;
      messageType: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<Record<string, unknown>> {
    this.createEventCalls.push({ chatId, metadata: event.metadata });
    return { ok: true };
  }

  public async createChat(taskId?: string): Promise<{ id: string }> {
    this.createChatCalls.push(taskId ?? "");
    return { id: `room-${this.createChatCalls.length}` };
  }

  public async listChatParticipants(): Promise<ChatParticipant[]> {
    return [];
  }

  public async addChatParticipant(
    chatId: string,
    participant: { participantId: string; role: string },
  ): Promise<Record<string, unknown>> {
    this.addParticipantCalls.push({
      chatId,
      participantId: participant.participantId,
    });
    return { ok: true };
  }

  public async removeChatParticipant(): Promise<Record<string, unknown>> {
    return { ok: true };
  }

  public async markMessageProcessing(): Promise<Record<string, unknown>> {
    return { ok: true };
  }

  public async markMessageProcessed(): Promise<Record<string, unknown>> {
    return { ok: true };
  }

  public async markMessageFailed(): Promise<Record<string, unknown>> {
    return { ok: true };
  }

  public async listPeers(
    request: { page: number; pageSize: number; notInChat: string },
  ): Promise<{ data: Array<Record<string, unknown>> }> {
    if (request.page > 1) {
      return { data: [] };
    }

    return {
      data: [
        {
          id: "peer-weather",
          name: "Weather Agent",
          handle: "weather-agent",
          description: "Weather specialist",
        },
        {
          id: "peer-data",
          name: "Data Agent",
          handle: "data-agent",
          description: "Data specialist",
        },
      ],
    };
  }
}

function makePeerMessage(options: {
  content: string;
  roomId?: string;
  senderId?: string;
  metadata?: Record<string, unknown>;
}) {
  return {
    ...makeMessage(options.content, options.roomId),
    senderId: options.senderId ?? "peer-weather",
    senderType: "Agent",
    senderName: "Peer Agent",
    metadata: options.metadata ?? {},
  };
}

describe("A2AGatewayAdapter", () => {
  it("rejects unauthenticated loopback mode on non-loopback hosts", () => {
    expect(
      () =>
        new A2AGatewayAdapter({
          thenvoiRest: new FakeRestApi(),
          allowUnauthenticatedLoopback: true,
          host: "0.0.0.0",
        }),
    ).toThrow("allowUnauthenticatedLoopback");
  });

  it("routes A2A requests into Thenvoi rooms and streams completion", async () => {
    const rest = new FakeRestApi();

    let onRequest: ((request: GatewayRequest) => AsyncIterable<unknown>) | null = null;
    let serverStarted = false;
    const serverFactory: GatewayServerFactory = (options) => {
      onRequest = options.onRequest;
      return {
        start: async () => {
          serverStarted = true;
        },
        stop: async () => {
          serverStarted = false;
        },
      } satisfies GatewayServerLike;
    };

    const adapter = new A2AGatewayAdapter({
      thenvoiRest: rest,
      serverFactory,
      responseTimeoutMs: 2_000,
    });

    await adapter.onStarted("Gateway", "A2A gateway");
    expect(serverStarted).toBe(true);
    expect(onRequest).not.toBeNull();

    const stream = onRequest!({
      peerId: "peer-weather",
      taskId: "task-1",
      contextId: "ctx-1",
      message: {
        kind: "message",
        messageId: "user-msg-1",
        role: "user",
        parts: [{ kind: "text", text: "What is the weather in NYC?" }],
      },
    });

    const iterator = stream[Symbol.asyncIterator]();
    const firstEvent = await iterator.next();
    expect(firstEvent.value).toMatchObject({
      kind: "status-update",
      final: false,
      status: { state: "working" },
    });

    await adapter.onMessage(
      makePeerMessage({
        content: "Sunny and 72F",
        roomId: "room-1",
      }),
      new FakeTools(),
      {
        contextToRoom: {},
        roomParticipants: {},
      },
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-1" },
    );

    const finalEvent = await iterator.next();
    expect(finalEvent.value).toMatchObject({
      kind: "status-update",
      final: true,
      status: { state: "completed" },
    });

    expect(rest.createChatCalls).toEqual([""]);
    expect(rest.addParticipantCalls).toEqual([
      { chatId: "room-1", participantId: "peer-weather" },
    ]);
    expect(rest.createEventCalls[0]?.metadata).toMatchObject({
      gateway_context_id: "ctx-1",
      gateway_room_id: "room-1",
    });
    expect(rest.createMessageCalls[0]).toMatchObject({
      chatId: "room-1",
      content: "@Weather Agent What is the weather in NYC?",
      mentions: [{ id: "peer-weather", handle: "weather-agent" }],
    });
    // The platform's chat-message endpoint no longer accepts a metadata
    // field; gateway tracking metadata only flows through createChatEvent.
    expect(rest.createMessageCalls[0]?.metadata).toBeUndefined();
  });

  it("forgets room mappings during cleanup", async () => {
    const adapter = new A2AGatewayAdapter({
      thenvoiRest: new FakeRestApi(),
    });
    const state = adapter as unknown as {
      contextToRoom: Map<string, string>;
      roomParticipants: Map<string, Set<string>>;
      pendingByRoom: Map<string, Map<string, { roomId: string; queue: { cancel(): void } }>>;
      pendingByTask: Map<string, { roomId: string }>;
    };
    let cancelled = false;

    state.contextToRoom.set("ctx-1", "room-1");
    state.roomParticipants.set("room-1", new Set(["peer-weather"]));
    state.pendingByRoom.set("room-1", new Map([
      ["task-1", { roomId: "room-1", queue: { cancel: () => { cancelled = true; } } }],
    ]));
    state.pendingByTask.set("task-1", { roomId: "room-1" });

    await adapter.onCleanup("room-1");

    expect(cancelled).toBe(true);
    expect(state.contextToRoom.size).toBe(0);
    expect(state.roomParticipants.size).toBe(0);
    expect(state.pendingByRoom.size).toBe(0);
    expect(state.pendingByTask.size).toBe(0);
  });

  it("clears tracked state on runtime stop", async () => {
    const rest = new FakeRestApi();
    let stopped = false;
    const adapter = new A2AGatewayAdapter({
      thenvoiRest: rest,
      serverFactory: () => ({
        start: async () => undefined,
        stop: async () => {
          stopped = true;
        },
      }),
    });
    const state = adapter as unknown as {
      peersBySlug: Map<string, unknown>;
      peersById: Map<string, unknown>;
      contextToRoom: Map<string, string>;
      roomParticipants: Map<string, Set<string>>;
      pendingByRoom: Map<string, Map<string, { roomId: string; queue: { cancel(): void } }>>;
      pendingByTask: Map<string, { roomId: string; queue: { cancel(): void } }>;
      server: { stop(): Promise<void> } | null;
    };
    let cancelled = false;

    await adapter.onStarted("Gateway", "A2A gateway");

    state.contextToRoom.set("ctx-1", "room-1");
    state.roomParticipants.set("room-1", new Set(["peer-weather"]));
    state.peersBySlug.set("weather", { id: "peer-weather" });
    state.peersById.set("peer-weather", { id: "peer-weather" });
    const pending = { roomId: "room-1", queue: { cancel: () => { cancelled = true; } } };
    state.pendingByTask.set("task-1", pending);
    state.pendingByRoom.set("room-1", new Map([["task-1", pending]]));

    await adapter.onRuntimeStop();

    expect(cancelled).toBe(true);
    expect(stopped).toBe(true);
    expect(state.peersBySlug.size).toBe(0);
    expect(state.peersById.size).toBe(0);
    expect(state.contextToRoom.size).toBe(0);
    expect(state.roomParticipants.size).toBe(0);
    expect(state.pendingByRoom.size).toBe(0);
    expect(state.pendingByTask.size).toBe(0);
  });

  it("supports legacy slug peerId aliases in gateway requests", async () => {
    const rest = new FakeRestApi();

    let onRequest: ((request: GatewayRequest) => AsyncIterable<unknown>) | null = null;
    const adapter = new A2AGatewayAdapter({
      thenvoiRest: rest,
      serverFactory: (options) => {
        onRequest = options.onRequest;
        return {
          start: async () => undefined,
          stop: async () => undefined,
        };
      },
      responseTimeoutMs: 2_000,
    });

    await adapter.onStarted("Gateway", "A2A gateway");

    const stream = onRequest!({
      peerId: "weather-agent",
      taskId: "task-legacy",
      contextId: "ctx-legacy",
      message: {
        kind: "message",
        messageId: "legacy-msg",
        role: "user",
        parts: [{ kind: "text", text: "Legacy slug" }],
      },
    });

    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next(); // working

    await adapter.onMessage(
      makePeerMessage({
        content: "legacy response",
        roomId: "room-1",
        senderId: "peer-weather",
      }),
      new FakeTools(),
      {
        contextToRoom: {},
        roomParticipants: {},
      },
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-1" },
    );

    const finalEvent = await iterator.next();
    expect(finalEvent.value).toMatchObject({
      kind: "status-update",
      final: true,
      status: { state: "completed" },
    });
    expect(rest.addParticipantCalls).toEqual([
      { chatId: "room-1", participantId: "peer-weather" },
    ]);
  });

  it("reuses a room for the same context and peer", async () => {
    const rest = new FakeRestApi();

    let onRequest: ((request: GatewayRequest) => AsyncIterable<unknown>) | null = null;
    const adapter = new A2AGatewayAdapter({
      thenvoiRest: rest,
      serverFactory: (options) => {
        onRequest = options.onRequest;
        return {
          start: async () => undefined,
          stop: async () => undefined,
        };
      },
      responseTimeoutMs: 2_000,
    });

    await adapter.onStarted("Gateway", "A2A gateway");

    const stream1 = onRequest!({
      peerId: "weather-agent",
      taskId: "task-1",
      contextId: "ctx-sticky",
      message: {
        kind: "message",
        messageId: "m-1",
        role: "user",
        parts: [{ kind: "text", text: "First" }],
      },
    });
    const iterator1 = stream1[Symbol.asyncIterator]();
    await iterator1.next();
    await adapter.onMessage(
      makePeerMessage({
        content: "done",
        roomId: "room-1",
      }),
      new FakeTools(),
      { contextToRoom: {}, roomParticipants: {} },
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-1" },
    );
    await iterator1.next();

    const stream2 = onRequest!({
      peerId: "weather-agent",
      taskId: "task-2",
      contextId: "ctx-sticky",
      message: {
        kind: "message",
        messageId: "m-2",
        role: "user",
        parts: [{ kind: "text", text: "Second" }],
      },
    });
    const iterator2 = stream2[Symbol.asyncIterator]();
    await iterator2.next();
    await adapter.onMessage(
      makePeerMessage({
        content: "done again",
        roomId: "room-1",
        metadata: {
          gateway_task_id: "task-2",
        },
      }),
      new FakeTools(),
      { contextToRoom: {}, roomParticipants: {} },
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-1" },
    );
    await iterator2.next();

    expect(rest.createChatCalls).toHaveLength(1);
    expect(rest.addParticipantCalls).toHaveLength(1);
  });

  it("returns a failed terminal event when peer does not exist", async () => {
    const rest = new FakeRestApi();

    let onRequest: ((request: GatewayRequest) => AsyncIterable<unknown>) | null = null;
    const adapter = new A2AGatewayAdapter({
      thenvoiRest: rest,
      serverFactory: (options) => {
        onRequest = options.onRequest;
        return {
          start: async () => undefined,
          stop: async () => undefined,
        };
      },
    });

    await adapter.onStarted("Gateway", "A2A gateway");

    const stream = onRequest!({
      peerId: "missing-peer",
      taskId: "task-missing",
      contextId: "ctx-missing",
      message: {
        kind: "message",
        messageId: "m-missing",
        role: "user",
        parts: [{ kind: "text", text: "Hello" }],
      },
    });

    const result = await stream[Symbol.asyncIterator]().next();
    expect(result.value).toMatchObject({
      kind: "status-update",
      final: true,
      status: { state: "failed" },
    });
    expect(rest.createMessageCalls).toHaveLength(0);
  });

  it("ignores unrelated participant updates for pending tasks", async () => {
    const rest = new FakeRestApi();

    let onRequest: ((request: GatewayRequest) => AsyncIterable<unknown>) | null = null;
    const adapter = new A2AGatewayAdapter({
      thenvoiRest: rest,
      serverFactory: (options) => {
        onRequest = options.onRequest;
        return {
          start: async () => undefined,
          stop: async () => undefined,
        };
      },
      responseTimeoutMs: 2_000,
    });

    await adapter.onStarted("Gateway", "A2A gateway");

    const stream = onRequest!({
      peerId: "weather-agent",
      taskId: "task-1",
      contextId: "ctx-1",
      message: {
        kind: "message",
        messageId: "m-1",
        role: "user",
        parts: [{ kind: "text", text: "Status?" }],
      },
    });

    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next(); // working

    await adapter.onMessage(
      makePeerMessage({
        content: "I am an unrelated peer",
        roomId: "room-1",
        senderId: "peer-data",
      }),
      new FakeTools(),
      { contextToRoom: {}, roomParticipants: {} },
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-1" },
    );

    await adapter.onMessage(
      makePeerMessage({
        content: "This is the target peer response",
        roomId: "room-1",
        senderId: "peer-weather",
      }),
      new FakeTools(),
      { contextToRoom: {}, roomParticipants: {} },
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-1" },
    );

    const finalEvent = await iterator.next();
    const text = finalEvent.value?.status?.message?.parts?.[0]?.text;
    expect(text).toBe("This is the target peer response");
  });

  it("accepts updates that include matching gateway task metadata", async () => {
    const rest = new FakeRestApi();

    let onRequest: ((request: GatewayRequest) => AsyncIterable<unknown>) | null = null;
    const adapter = new A2AGatewayAdapter({
      thenvoiRest: rest,
      serverFactory: (options) => {
        onRequest = options.onRequest;
        return {
          start: async () => undefined,
          stop: async () => undefined,
        };
      },
      responseTimeoutMs: 2_000,
    });

    await adapter.onStarted("Gateway", "A2A gateway");

    const stream = onRequest!({
      peerId: "weather-agent",
      taskId: "task-2",
      contextId: "ctx-2",
      message: {
        kind: "message",
        messageId: "m-2",
        role: "user",
        parts: [{ kind: "text", text: "Metadata route" }],
      },
    });

    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next(); // working

    await adapter.onMessage(
      makePeerMessage({
        content: "matched by task metadata",
        roomId: "room-1",
        senderId: "peer-data",
        metadata: {
          gateway_task_id: "task-2",
        },
      }),
      new FakeTools(),
      { contextToRoom: {}, roomParticipants: {} },
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-1" },
    );

    const finalEvent = await iterator.next();
    const text = finalEvent.value?.status?.message?.parts?.[0]?.text;
    expect(text).toBe("matched by task metadata");
  });

  it("accepts legacy slug values in gateway_peer_id metadata", async () => {
    const rest = new FakeRestApi();

    let onRequest: ((request: GatewayRequest) => AsyncIterable<unknown>) | null = null;
    const adapter = new A2AGatewayAdapter({
      thenvoiRest: rest,
      serverFactory: (options) => {
        onRequest = options.onRequest;
        return {
          start: async () => undefined,
          stop: async () => undefined,
        };
      },
      responseTimeoutMs: 2_000,
    });

    await adapter.onStarted("Gateway", "A2A gateway");

    const stream = onRequest!({
      peerId: "peer-weather",
      taskId: "task-slug-metadata",
      contextId: "ctx-slug-metadata",
      message: {
        kind: "message",
        messageId: "m-slug-metadata",
        role: "user",
        parts: [{ kind: "text", text: "Metadata alias route" }],
      },
    });

    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next(); // working

    await adapter.onMessage(
      makePeerMessage({
        content: "matched by legacy gateway_peer_id slug",
        roomId: "room-1",
        senderId: "peer-data",
        metadata: {
          gateway_peer_id: "weather-agent",
        },
      }),
      new FakeTools(),
      { contextToRoom: {}, roomParticipants: {} },
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-1" },
    );

    const finalEvent = await iterator.next();
    const text = finalEvent.value?.status?.message?.parts?.[0]?.text;
    expect(text).toBe("matched by legacy gateway_peer_id slug");
  });

  it("keeps concurrent room tasks independent and requires task metadata when overlapping", async () => {
    const rest = new FakeRestApi();

    let onRequest: ((request: GatewayRequest) => AsyncIterable<unknown>) | null = null;
    const adapter = new A2AGatewayAdapter({
      thenvoiRest: rest,
      serverFactory: (options) => {
        onRequest = options.onRequest;
        return {
          start: async () => undefined,
          stop: async () => undefined,
        };
      },
      responseTimeoutMs: 2_000,
    });

    await adapter.onStarted("Gateway", "A2A gateway");

    const oldStream = onRequest!({
      peerId: "weather-agent",
      taskId: "task-old",
      contextId: "ctx-race",
      message: {
        kind: "message",
        messageId: "m-old",
        role: "user",
        parts: [{ kind: "text", text: "First request" }],
      },
    });
    const oldIterator = oldStream[Symbol.asyncIterator]();
    await oldIterator.next(); // old working

    const newStream = onRequest!({
      peerId: "weather-agent",
      taskId: "task-new",
      contextId: "ctx-race",
      message: {
        kind: "message",
        messageId: "m-new",
        role: "user",
        parts: [{ kind: "text", text: "Second request" }],
      },
    });
    const newIterator = newStream[Symbol.asyncIterator]();
    await newIterator.next(); // new working

    await adapter.onMessage(
      makePeerMessage({
        content: "stale sender-only message",
        roomId: "room-1",
        senderId: "peer-weather",
      }),
      new FakeTools(),
      { contextToRoom: {}, roomParticipants: {} },
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-1" },
    );

    await adapter.onMessage(
      makePeerMessage({
        content: "response for old task",
        roomId: "room-1",
        senderId: "peer-weather",
        metadata: {
          gateway_task_id: "task-old",
        },
      }),
      new FakeTools(),
      { contextToRoom: {}, roomParticipants: {} },
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-1" },
    );

    await adapter.onMessage(
      makePeerMessage({
        content: "response for new task",
        roomId: "room-1",
        senderId: "peer-weather",
        metadata: {
          gateway_task_id: "task-new",
        },
      }),
      new FakeTools(),
      { contextToRoom: {}, roomParticipants: {} },
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-1" },
    );

    const oldFinal = await oldIterator.next();
    expect(oldFinal.value?.final).toBe(true);
    expect(oldFinal.value?.status?.state).toBe("completed");
    expect(oldFinal.value?.status?.message?.parts?.[0]?.text).toBe("response for old task");

    const newFinal = await newIterator.next();
    const text = newFinal.value?.status?.message?.parts?.[0]?.text;
    expect(text).toBe("response for new task");
  });
});
