import { beforeEach, describe, expect, it, vi } from "vitest";

import { GenericAdapter } from "../src/adapters/GenericAdapter";
import { TransportError } from "../src/core/errors";
import { BandLink } from "../src/platform/BandLink";
import { WebSocketDisconnectError } from "../src/platform/streaming/disconnectReason";
import { PlatformRuntime } from "../src/runtime/PlatformRuntime";
import { FakeRestApi } from "./testUtils";

const phoenixMock = vi.hoisted(() => {
  type Outcome = "ok" | "error" | "timeout" | "pending";

  // Models Phoenix's real behavior: one join `Push` per channel, reused for
  // every automatic rejoin. `.receive()` hooks registered on it accumulate
  // and are re-fired on every settlement, never just the first.
  class FakeJoinPush {
    private readonly hooks: Array<{
      status: Exclude<Outcome, "pending">;
      callback: (payload?: unknown) => void;
    }> = [];

    public receive(
      status: Outcome,
      callback: (payload?: unknown) => void,
    ): FakeJoinPush {
      if (status !== "pending") {
        this.hooks.push({ status, callback });
      }
      return this;
    }

    public settle(outcome: Exclude<Outcome, "pending">): void {
      for (const hook of this.hooks) {
        if (hook.status === outcome) {
          queueMicrotask(() =>
            hook.callback(outcome === "ok" ? {} : { error: outcome }),
          );
        }
      }
    }
  }

  class FakeChannel {
    public readonly topic: string;
    public readonly handlers = new Map<
      string,
      (payload: Record<string, unknown>) => void
    >();
    public joinOutcome: Outcome = "ok";
    public leaveOutcome: Outcome = "ok";
    public leaveCallCount = 0;
    public readonly joinPush = new FakeJoinPush();
    private nextRef = 1;

    public constructor(topic: string) {
      this.topic = topic;
    }

    public on(
      event: string,
      handler: (payload: Record<string, unknown>) => void,
    ): number {
      this.handlers.set(event, handler);
      return this.nextRef++;
    }

    public off(_event: string, _ref?: number): void {
      // In a real implementation this would remove the specific handler
    }

    public emit(event: string, payload: Record<string, unknown>): void {
      this.handlers.get(event)?.(payload);
    }

    public join(): FakeJoinPush {
      const outcome = this.joinOutcome;
      if (outcome !== "pending") {
        // Deferred, like a real server round-trip: `doJoin` registers its
        // receive hooks synchronously right after this returns, and they
        // must be in place before the settlement fires.
        queueMicrotask(() => this.joinPush.settle(outcome));
      }
      return this.joinPush;
    }

    /** Simulates Phoenix resending this channel's join push on a later
     *  automatic rejoin, without calling `.join()` again. */
    public settleRejoin(outcome: Exclude<Outcome, "pending">): void {
      this.joinPush.settle(outcome);
    }

    public leave(): {
      receive: (
        kind: Outcome,
        callback: (payload?: unknown) => void,
      ) => unknown;
    } {
      this.leaveCallCount += 1;
      return this.receiver(this.leaveOutcome);
    }

    private receiver(outcome: Outcome): {
      receive: (
        kind: Outcome,
        callback: (payload?: unknown) => void,
      ) => unknown;
    } {
      const chain = {
        receive: (kind: Outcome, callback: (payload?: unknown) => void) => {
          if (kind === outcome && kind !== "pending") {
            queueMicrotask(() =>
              callback(kind === "ok" ? {} : { error: kind }),
            );
          }
          return chain;
        },
      };
      return chain;
    }
  }

  class FakeChannelList extends Array<FakeChannel> {
    public get(topic: string): FakeChannel | undefined {
      return this.find((channel) => channel.topic === topic);
    }

    public has(topic: string): boolean {
      return this.some((channel) => channel.topic === topic);
    }

    public delete(channelToDelete: FakeChannel): boolean {
      const index = this.indexOf(channelToDelete);
      if (index < 0) {
        return false;
      }
      this.splice(index, 1);
      return true;
    }
  }

  class FakeSocket {
    public static readonly instances: FakeSocket[] = [];

    public readonly url: string;
    public readonly params: Record<string, unknown>;
    public readonly reconnectAfterMs?: (tries: number) => number;
    public readonly channels = new FakeChannelList();
    public readonly joinOutcomes = new Map<string, Outcome>();
    public disconnectCount = 0;
    private openHandler: (() => void) | null = null;
    private closeHandler:
      | ((event?: { code?: number; reason?: string }) => void)
      | null = null;
    private errorHandler: ((payload: unknown) => void) | null = null;

    public constructor(
      url: string,
      options: {
        params: Record<string, unknown>;
        reconnectAfterMs?: (tries: number) => number;
      },
    ) {
      this.url = url;
      this.params = options.params;
      this.reconnectAfterMs = options.reconnectAfterMs;
      FakeSocket.instances.push(this);
    }

    public onOpen(handler: () => void): void {
      this.openHandler = handler;
    }

    public onClose(
      handler: (event?: { code?: number; reason?: string }) => void,
    ): void {
      this.closeHandler = handler;
    }

    public onError(handler: (payload: unknown) => void): void {
      this.errorHandler = handler;
    }

    public connect(): void {
      queueMicrotask(() => {
        this.openHandler?.();
      });
    }

    /** Simulates a later automatic reconnect's socket re-open. */
    public emitOpen(): void {
      this.openHandler?.();
    }

    public disconnect(): void {
      this.disconnectCount += 1;
      this.closeHandler?.();
    }

    public emitClose(event?: { code?: number; reason?: string }): void {
      this.closeHandler?.(event);
    }

    public channel(topic: string): FakeChannel {
      const channel = new FakeChannel(topic);
      channel.joinOutcome = this.joinOutcomes.get(topic) ?? "ok";
      this.channels.push(channel);
      return channel;
    }

    public remove(channel: FakeChannel): void {
      this.channels.delete(channel);
    }

    public emitError(payload: unknown): void {
      this.errorHandler?.(payload);
    }
  }

  return {
    FakeChannel,
    FakeSocket,
    reset: () => {
      FakeSocket.instances.splice(0, FakeSocket.instances.length);
    },
  };
});

vi.mock("phoenix", () => ({
  Channel: phoenixMock.FakeChannel,
  Socket: phoenixMock.FakeSocket,
}));

import { PhoenixChannelsTransport } from "../src/platform/streaming/PhoenixChannelsTransport";

describe("PhoenixChannelsTransport", () => {
  beforeEach(() => {
    phoenixMock.reset();
  });

  it("normalizes websocket URL and connects once", async () => {
    const transport = new PhoenixChannelsTransport({
      wsUrl: "wss://example.test/socket/websocket",
      apiKey: "key-1",
      agentId: "agent-1",
    });

    const socket = phoenixMock.FakeSocket.instances[0];
    expect(socket?.url).toBe("wss://example.test/socket");
    expect(socket?.params).toMatchObject({
      agent_id: "agent-1",
    });
    expect(socket?.params).not.toHaveProperty("api_key");

    await transport.connect();
    await transport.connect();
    expect(transport.isConnected()).toBe(true);
  });

  it("passes explicit conflict policy as a socket param", () => {
    new PhoenixChannelsTransport({
      wsUrl: "wss://example.test/socket",
      apiKey: "key-1",
      agentId: "agent-1",
      conflictPolicy: "reject",
    });

    expect(phoenixMock.FakeSocket.instances[0]?.params).toMatchObject({
      on_conflict: "reject",
    });
  });

  it("passes BandLink conflict policy into the socket params", () => {
    new BandLink({
      agentId: "agent-1",
      apiKey: "key-1",
      restApi: new FakeRestApi(),
      wsUrl: "wss://example.test/socket",
      conflictPolicy: "reject",
    });

    expect(phoenixMock.FakeSocket.instances[0]?.params).toMatchObject({
      on_conflict: "reject",
    });
  });

  it("joins and leaves topics and dispatches topic handlers", async () => {
    const onMessage = vi.fn(async () => {});
    const transport = new PhoenixChannelsTransport({
      wsUrl: "wss://example.test/socket",
      apiKey: "key-1",
    });
    await transport.connect();

    await transport.join("room:1", { message: onMessage });
    const socket = phoenixMock.FakeSocket.instances[0];
    const channel = socket?.channels.get("room:1");
    channel?.emit("message", { body: "hello" });

    expect(onMessage).toHaveBeenCalledWith({ body: "hello" });

    await transport.leave("room:1");
    await expect(transport.leave("room:1")).resolves.toBeUndefined();
  });

  it("coalesces concurrent leave() calls for the same topic into one physical leave", async () => {
    const transport = new PhoenixChannelsTransport({
      wsUrl: "wss://example.test/socket",
      apiKey: "key-1",
    });
    await transport.connect();
    await transport.join("room:1", {});

    const channel = phoenixMock.FakeSocket.instances[0]?.channels.get("room:1");
    expect(channel).toBeDefined();

    // Two callers leaving the same topic without awaiting the first — e.g.
    // disconnect()'s unconditional per-topic leave racing a reconciliation
    // leave for the same topic — must share one in-flight leave rather than
    // sending a second, redundant `phx_leave`.
    const first = transport.leave("room:1");
    const second = transport.leave("room:1");

    await Promise.all([first, second]);

    expect(channel?.leaveCallCount).toBe(1);
  });

  it("wraps join failures in TransportError", async () => {
    const transport = new PhoenixChannelsTransport({
      wsUrl: "wss://example.test/socket",
      apiKey: "key-1",
    });
    await transport.connect();

    const socket = phoenixMock.FakeSocket.instances[0];
    if (socket) {
      const originalChannel = socket.channel.bind(socket);
      socket.channel = (topic: string) => {
        const channel = originalChannel(topic);
        channel.joinOutcome = "error";
        return channel;
      };
    }

    await expect(
      transport.join("room:error", {
        message: async () => {},
      }),
    ).rejects.toBeInstanceOf(TransportError);
  });

  it("rejects and removes a join that settles after disconnect", async () => {
    const transport = new PhoenixChannelsTransport({
      wsUrl: "wss://example.test/socket",
      apiKey: "key-1",
    });
    await transport.connect();

    const socket = phoenixMock.FakeSocket.instances[0];
    socket?.joinOutcomes.set("room:late", "pending");
    const staleJoin = transport.join("room:late", {});

    await transport.disconnect();
    socket?.joinOutcomes.delete("room:late");
    await transport.connect();
    const freshJoin = transport.join("room:late", {});
    await expect(freshJoin).resolves.toBeUndefined();

    socket?.channels.get("room:late")?.settleRejoin("ok");
    await expect(staleJoin).rejects.toThrow("superseded by transport disconnect");
    expect(socket?.channels.has("room:late")).toBe(true);
  });

  it("forgets local channel ownership when a disconnect leave fails", async () => {
    const transport = new PhoenixChannelsTransport({
      wsUrl: "wss://example.test/socket",
      apiKey: "key-1",
    });
    await transport.connect();
    await transport.join("room:failed-leave", {});

    const socket = phoenixMock.FakeSocket.instances[0];
    const oldChannel = socket?.channels.get("room:failed-leave");
    if (oldChannel) {
      oldChannel.leaveOutcome = "error";
    }

    await expect(transport.disconnect()).rejects.toThrow(AggregateError);
    expect(socket?.channels.has("room:failed-leave")).toBe(false);

    await transport.connect();
    await expect(transport.join("room:failed-leave", {})).resolves.toBeUndefined();
    expect(socket?.channels.has("room:failed-leave")).toBe(true);
  });

  it("does not report connected while mandatory agent_control join is pending", async () => {
    const transport = new PhoenixChannelsTransport({
      wsUrl: "wss://example.test/socket",
      apiKey: "key-1",
      agentId: "agent-1",
    });

    const socket = phoenixMock.FakeSocket.instances[0];
    if (socket) {
      const originalChannel = socket.channel.bind(socket);
      socket.channel = (topic: string) => {
        const channel = originalChannel(topic);
        if (topic === "agent_control:agent-1") {
          channel.joinOutcome = "pending";
        }
        return channel;
      };
    }

    const connectPromise = transport.connect();
    await Promise.resolve();
    await Promise.resolve();

    expect(transport.isConnected()).toBe(false);

    socket?.emitError({ status: 403 });
    await expect(connectPromise).rejects.toBeInstanceOf(TransportError);
  });

  it("rejects connect when mandatory agent_control join fails", async () => {
    const transport = new PhoenixChannelsTransport({
      wsUrl: "wss://example.test/socket",
      apiKey: "key-1",
      agentId: "agent-1",
    });

    const socket = phoenixMock.FakeSocket.instances[0];
    if (socket) {
      const originalChannel = socket.channel.bind(socket);
      socket.channel = (topic: string) => {
        const channel = originalChannel(topic);
        if (topic === "agent_control:agent-1") {
          channel.joinOutcome = "error";
        }
        return channel;
      };
    }

    await expect(transport.connect()).rejects.toBeInstanceOf(TransportError);
    expect(transport.isConnected()).toBe(false);
    expect(socket?.disconnectCount).toBeGreaterThan(0);
  });

  it("does not require agent_control when no agent id is configured", async () => {
    const transport = new PhoenixChannelsTransport({
      wsUrl: "wss://example.test/socket",
      apiKey: "key-1",
    });

    const socket = phoenixMock.FakeSocket.instances[0];
    if (socket) {
      const originalChannel = socket.channel.bind(socket);
      socket.channel = (topic: string) => {
        const channel = originalChannel(topic);
        channel.joinOutcome = "error";
        return channel;
      };
    }

    await expect(transport.connect()).resolves.toBeUndefined();
    expect(transport.isConnected()).toBe(true);
    expect(socket?.channels.has("agent_control:agent-1")).toBe(false);
  });

  it("records agent_control supersede as terminal and disables reconnect", async () => {
    const onTerminalDisconnect = vi.fn();
    const transport = new PhoenixChannelsTransport({
      wsUrl: "wss://example.test/socket",
      apiKey: "key-1",
      agentId: "agent-1",
      onTerminalDisconnect,
    });

    await transport.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const socket = phoenixMock.FakeSocket.instances[0];
    const control = socket?.channels.get("agent_control:agent-1");
    expect(control).toBeDefined();

    control?.emit("supersede", {
      reason: "session.already_connected",
      message:
        "This connection has been superseded by a newer session for this agent.",
      retryable: false,
      retry_after: 5,
      target_socket_id: "agent_socket:agent-1",
      correlation_id: "evict-1",
    });

    const reason = transport.getDisconnectReason();
    expect(reason).toMatchObject({
      source: "agent_control",
      code: "session.already_connected",
      message:
        "This connection has been superseded by a newer session for this agent.",
      retryable: false,
      retryAfter: 5,
      targetSocketId: "agent_socket:agent-1",
      correlationId: "evict-1",
    });
    expect(onTerminalDisconnect).toHaveBeenCalledWith(reason);
    expect(socket?.disconnectCount).toBeGreaterThan(0);
    expect(socket?.reconnectAfterMs?.(1)).toBe(Number.POSITIVE_INFINITY);
    await expect(transport.connect()).rejects.toBeInstanceOf(
      WebSocketDisconnectError,
    );
  });

  it("rejects runForever waiters on terminal supersede", async () => {
    const transport = new PhoenixChannelsTransport({
      wsUrl: "wss://example.test/socket",
      apiKey: "key-1",
      agentId: "agent-1",
    });

    await transport.connect();
    const abortController = new AbortController();
    const runForever = transport.runForever(abortController.signal);
    const socket = phoenixMock.FakeSocket.instances[0];
    socket?.channels.get("agent_control:agent-1")?.emit("supersede", {
      reason: "session.already_connected",
      message:
        "This connection has been superseded by a newer session for this agent.",
    });

    await expect(runForever).rejects.toBeInstanceOf(WebSocketDisconnectError);
  });

  it("keeps a close without supersede generic and retryable", async () => {
    const transport = new PhoenixChannelsTransport({
      wsUrl: "wss://example.test/socket",
      apiKey: "key-1",
      agentId: "agent-1",
    });

    await transport.connect();
    const socket = phoenixMock.FakeSocket.instances[0];
    socket?.emitClose({ code: 1006, reason: "" });

    expect(transport.getDisconnectReason()).toEqual({
      source: "websocket_close",
      code: "websocket.closed",
      message: "Phoenix socket closed without a platform disconnect reason.",
      retryable: true,
      closeCode: 1006,
      closeReason: null,
    });
    expect(socket?.reconnectAfterMs?.(1)).toBe(1000);
  });

  it.each([
    [409, "connection_conflict", null, null],
    [429, "too_many_requests", 7, "req-1"],
    [400, "invalid_on_conflict", null, "req-1"],
    [503, "tracking_failed", null, "req-1"],
  ] as const)(
    "parses HTTP %s upgrade error %s",
    async (status, code, retryAfter, requestId) => {
      const transport = new PhoenixChannelsTransport({
        wsUrl: "wss://example.test/socket",
        apiKey: "key-1",
        agentId: "agent-1",
      });

      const connectPromise = transport.connect();
      const socket = phoenixMock.FakeSocket.instances[0];
      socket?.emitError({
        status,
        body: {
          error: {
            code,
            message: `upgrade failed: ${code}`,
            request_id: requestId,
            retry_after: retryAfter,
          },
        },
        headers:
          retryAfter === null ? {} : { "Retry-After": String(retryAfter) },
      });

      await expect(connectPromise).rejects.toBeInstanceOf(
        WebSocketDisconnectError,
      );
      expect(transport.getDisconnectReason()).toMatchObject({
        source: "upgrade",
        status,
        code,
        message: `upgrade failed: ${code}`,
        requestId,
        retryAfter,
      });
    },
  );

  it("treats non-retryable upgrade failures as terminal", async () => {
    const transport = new PhoenixChannelsTransport({
      wsUrl: "wss://example.test/socket",
      apiKey: "key-1",
      agentId: "agent-1",
    });

    const connectPromise = transport.connect();
    const socket = phoenixMock.FakeSocket.instances[0];
    socket?.emitError({
      status: 409,
      body: {
        error: {
          code: "connection_conflict",
          message: "Connection already exists for this agent.",
          request_id: null,
        },
      },
    });

    await expect(connectPromise).rejects.toBeInstanceOf(
      WebSocketDisconnectError,
    );
    expect(socket?.disconnectCount).toBeGreaterThan(0);
    expect(socket?.reconnectAfterMs?.(1)).toBe(Number.POSITIVE_INFINITY);
    await expect(transport.connect()).rejects.toBeInstanceOf(
      WebSocketDisconnectError,
    );
  });

  it("keeps retryable upgrade failures non-terminal", async () => {
    const transport = new PhoenixChannelsTransport({
      wsUrl: "wss://example.test/socket",
      apiKey: "key-1",
      agentId: "agent-1",
    });

    const connectPromise = transport.connect();
    const socket = phoenixMock.FakeSocket.instances[0];
    socket?.emitError({
      status: 429,
      body: {
        error: {
          code: "too_many_requests",
          message: "Too many websocket connection attempts.",
          retry_after: 7,
          request_id: null,
        },
      },
    });

    await expect(connectPromise).rejects.toBeInstanceOf(
      WebSocketDisconnectError,
    );
    expect(socket?.disconnectCount).toBeGreaterThan(0);
    expect(socket?.reconnectAfterMs?.(1)).toBe(1000);
  });

  it("rejects empty 403 upgrade errors without inventing a platform reason", async () => {
    const transport = new PhoenixChannelsTransport({
      wsUrl: "wss://example.test/socket",
      apiKey: "key-1",
      agentId: "agent-1",
    });

    const connectPromise = transport.connect();
    const socket = phoenixMock.FakeSocket.instances[0];
    socket?.emitError({ status: 403 });

    await expect(connectPromise).rejects.toBeInstanceOf(TransportError);
    expect(socket?.disconnectCount).toBeGreaterThan(0);
    expect(transport.getDisconnectReason()).toBeNull();
  });

  it("propagates terminal supersede through the agent runtime", async () => {
    const runtime = new PlatformRuntime({
      agentId: "agent-1",
      apiKey: "key-1",
      link: new BandLink({
        agentId: "agent-1",
        apiKey: "key-1",
        restApi: new FakeRestApi(),
        wsUrl: "wss://example.test/socket",
      }),
    });

    await runtime.start(new GenericAdapter(async () => undefined));
    const runForever = runtime.runForever();
    const socket = phoenixMock.FakeSocket.instances[0];

    socket?.channels.get("agent_control:agent-1")?.emit("supersede", {
      reason: "session.already_connected",
      message:
        "This connection has been superseded by a newer session for this agent.",
    });

    await expect(runForever).rejects.toBeInstanceOf(WebSocketDisconnectError);
  });

  it("cleans up in-flight executions after terminal supersede", async () => {
    const cleanupRooms: string[] = [];
    let resolveStarted: (() => void) | undefined;
    let releaseExecution: (() => void) | undefined;
    const executionStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const executionReleased = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const runtime = new PlatformRuntime({
      agentId: "agent-1",
      apiKey: "key-1",
      link: new BandLink({
        agentId: "agent-1",
        apiKey: "key-1",
        restApi: new FakeRestApi(),
        wsUrl: "wss://example.test/socket",
      }),
    });

    await runtime.start({
      onStarted: vi.fn(async () => undefined),
      onCleanup: vi.fn(async (roomId) => {
        cleanupRooms.push(roomId);
      }),
      onRuntimeStop: vi.fn(async () => undefined),
      onEvent: vi.fn(async () => {
        resolveStarted?.();
        await executionReleased;
      }),
    });
    const runForever = runtime.runForever();
    const socket = phoenixMock.FakeSocket.instances[0];

    socket?.channels.get("agent_rooms:agent-1")?.emit("room_added", {
      id: "room-1",
      status: "active",
      type: "direct",
      title: "Room",
      removed_at: null,
    });
    await vi.waitFor(() => {
      expect(socket?.channels.has("chat_room:room-1")).toBe(true);
    });

    socket?.channels.get("chat_room:room-1")?.emit("message_created", {
      id: "m1",
      content: "work",
      message_type: "text",
      sender_id: "user-1",
      sender_type: "User",
      sender_name: "User",
      metadata: {},
      inserted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    await executionStarted;

    socket?.channels.get("agent_control:agent-1")?.emit("supersede", {
      reason: "session.already_connected",
      message:
        "This connection has been superseded by a newer session for this agent.",
    });
    await expect(runForever).rejects.toBeInstanceOf(WebSocketDisconnectError);

    await expect(runtime.stop(0)).rejects.toBeInstanceOf(WebSocketDisconnectError);
    expect(cleanupRooms).toEqual(["room-1"]);

    releaseExecution?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  describe("reconnect snapshot", () => {
    it("does not invoke the reconnect observer for the initial socket open", async () => {
      const transport = new PhoenixChannelsTransport({
        wsUrl: "wss://example.test/socket",
        apiKey: "key-1",
      });
      const observer = vi.fn();
      transport.onReconnected(observer);

      await transport.connect();
      await transport.join("room:1", {});
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(observer).not.toHaveBeenCalled();
    });

    it("invokes the observer only after every snapshotted topic settles", async () => {
      const transport = new PhoenixChannelsTransport({
        wsUrl: "wss://example.test/socket",
        apiKey: "key-1",
      });
      await transport.connect();
      await transport.join("room:1", {});
      await transport.join("room:2", {});

      const observer = vi.fn();
      transport.onReconnected(observer);

      const socket = phoenixMock.FakeSocket.instances[0];
      socket?.emitOpen();
      socket?.channels.get("room:1")?.settleRejoin("ok");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(observer).not.toHaveBeenCalled();

      socket?.channels.get("room:2")?.settleRejoin("ok");
      await vi.waitFor(() => expect(observer).toHaveBeenCalledTimes(1));
      expect(observer).toHaveBeenCalledWith({
        generation: 1,
        attemptedTopics: new Set(["room:1", "room:2"]),
        joinedTopics: new Set(["room:1", "room:2"]),
      });
    });

    it("holds post-open topic events until the reconnect observer establishes the recovery boundary", async () => {
      const transport = new PhoenixChannelsTransport({
        wsUrl: "wss://example.test/socket",
        apiKey: "key-1",
      });
      const order: string[] = [];
      let releaseObserver: (() => void) | undefined;
      const observerReleased = new Promise<void>((resolve) => {
        releaseObserver = resolve;
      });

      await transport.connect();
      await transport.join("room:1", {
        message_created: () => {
          order.push("message");
        },
      });
      transport.onReconnected(async () => {
        order.push("reconnected");
        await observerReleased;
      });

      const socket = phoenixMock.FakeSocket.instances[0];
      socket?.emitOpen();
      socket?.channels.get("room:1")?.emit("message_created", {});
      socket?.channels.get("room:1")?.settleRejoin("ok");

      await vi.waitFor(() => expect(order).toEqual(["reconnected"]));
      releaseObserver?.();
      await vi.waitFor(() => expect(order).toEqual(["reconnected", "message"]));
    });

    it("holds a replacement join until reconnect reconciliation completes", async () => {
      const transport = new PhoenixChannelsTransport({
        wsUrl: "wss://example.test/socket",
        apiKey: "key-1",
      });
      let releaseObserver: (() => void) | undefined;
      const observerReleased = new Promise<void>((resolve) => {
        releaseObserver = resolve;
      });
      const observer = vi.fn(async () => observerReleased);

      await transport.connect();
      await transport.join("room:1", {});
      transport.onReconnected(observer);

      const socket = phoenixMock.FakeSocket.instances[0];
      socket?.emitOpen();
      socket?.channels.get("room:1")?.settleRejoin("ok");
      await vi.waitFor(() => expect(observer).toHaveBeenCalledTimes(1));

      await transport.leave("room:1");
      const replacementJoin = transport.join("room:1", {});
      let joined = false;
      void replacementJoin.then(() => {
        joined = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(joined).toBe(false);

      releaseObserver?.();
      await replacementJoin;
      expect(joined).toBe(true);
    });

    it("delivers agent_control supersede without waiting for room-topic settlement", async () => {
      const onTerminalDisconnect = vi.fn();
      const transport = new PhoenixChannelsTransport({
        wsUrl: "wss://example.test/socket",
        apiKey: "key-1",
        agentId: "agent-1",
        onTerminalDisconnect,
      });
      await transport.connect();
      await transport.join("room:1", {});

      const socket = phoenixMock.FakeSocket.instances[0];
      socket?.emitOpen();
      socket?.channels.get("agent_control:agent-1")?.settleRejoin("ok");
      socket?.channels.get("agent_control:agent-1")?.emit("supersede", {
        reason: "session.already_connected",
        message: "Superseded by another session",
      });

      expect(onTerminalDisconnect).toHaveBeenCalledTimes(1);
    });

    it("omits topics whose rejoin settles as rejected or timed out", async () => {
      const transport = new PhoenixChannelsTransport({
        wsUrl: "wss://example.test/socket",
        apiKey: "key-1",
      });
      await transport.connect();
      await transport.join("room:1", {});
      await transport.join("room:2", {});
      await transport.join("room:3", {});

      const observer = vi.fn();
      transport.onReconnected(observer);

      const socket = phoenixMock.FakeSocket.instances[0];
      socket?.emitOpen();
      socket?.channels.get("room:1")?.settleRejoin("ok");
      socket?.channels.get("room:2")?.settleRejoin("error");
      socket?.channels.get("room:3")?.settleRejoin("timeout");

      await vi.waitFor(() => expect(observer).toHaveBeenCalledTimes(1));
      expect(observer).toHaveBeenCalledWith({
        generation: 1,
        attemptedTopics: new Set(["room:1", "room:2", "room:3"]),
        joinedTopics: new Set(["room:1"]),
      });
    });

    it("removes a topic from the pending snapshot when it is explicitly left before settling", async () => {
      const transport = new PhoenixChannelsTransport({
        wsUrl: "wss://example.test/socket",
        apiKey: "key-1",
      });
      await transport.connect();
      await transport.join("room:1", {});
      await transport.join("room:2", {});

      const observer = vi.fn();
      transport.onReconnected(observer);

      const socket = phoenixMock.FakeSocket.instances[0];
      socket?.emitOpen();
      socket?.channels.get("room:1")?.settleRejoin("ok");
      await transport.leave("room:2");

      await vi.waitFor(() => expect(observer).toHaveBeenCalledTimes(1));
      expect(observer).toHaveBeenCalledWith({
        generation: 1,
        attemptedTopics: new Set(["room:1", "room:2"]),
        joinedTopics: new Set(["room:1"]),
      });
    });

    it("lets a newer open generation supersede an incomplete older settlement", async () => {
      const transport = new PhoenixChannelsTransport({
        wsUrl: "wss://example.test/socket",
        apiKey: "key-1",
      });
      await transport.connect();
      await transport.join("room:1", {});
      await transport.join("room:2", {});

      const observer = vi.fn();
      transport.onReconnected(observer);

      const socket = phoenixMock.FakeSocket.instances[0];
      socket?.emitOpen();
      socket?.channels.get("room:1")?.settleRejoin("ok");
      // room:2 never settles for this generation before a second open fires.

      socket?.emitOpen();
      socket?.channels.get("room:1")?.settleRejoin("ok");
      socket?.channels.get("room:2")?.settleRejoin("ok");

      await vi.waitFor(() => expect(observer).toHaveBeenCalledTimes(1));
      expect(observer).toHaveBeenCalledWith({
        generation: 2,
        attemptedTopics: new Set(["room:1", "room:2"]),
        joinedTopics: new Set(["room:1", "room:2"]),
      });
    });

    it("logs a reconnect observer failure instead of leaking an unhandled rejection", async () => {
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const transport = new PhoenixChannelsTransport({
        wsUrl: "wss://example.test/socket",
        apiKey: "key-1",
        logger,
      });
      await transport.connect();
      await transport.join("room:1", {});

      const failure = new Error("observer boom");
      transport.onReconnected(() => {
        throw failure;
      });

      const socket = phoenixMock.FakeSocket.instances[0];
      socket?.emitOpen();
      socket?.channels.get("room:1")?.settleRejoin("ok");

      await vi.waitFor(() =>
        expect(logger.error).toHaveBeenCalledWith(
          "Reconnect observer failed",
          expect.objectContaining({ generation: 1, error: failure }),
        ),
      );
    });

    it("stops notifying an observer once it unsubscribes", async () => {
      const transport = new PhoenixChannelsTransport({
        wsUrl: "wss://example.test/socket",
        apiKey: "key-1",
      });
      await transport.connect();
      await transport.join("room:1", {});

      const observer = vi.fn();
      const unsubscribe = transport.onReconnected(observer);
      unsubscribe();

      const socket = phoenixMock.FakeSocket.instances[0];
      socket?.emitOpen();
      socket?.channels.get("room:1")?.settleRejoin("ok");
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(observer).not.toHaveBeenCalled();
    });

    it("does not deliver a buffered event for a topic that was explicitly left before its generation settles", async () => {
      const onMessage = vi.fn(async () => {});
      const transport = new PhoenixChannelsTransport({
        wsUrl: "wss://example.test/socket",
        apiKey: "key-1",
      });
      await transport.connect();
      await transport.join("room:1", { message: onMessage });

      const socket = phoenixMock.FakeSocket.instances[0];
      socket?.emitOpen();

      // Arrives mid-reconnect, before room:1's rejoin has settled, so it is
      // buffered rather than delivered immediately.
      socket?.channels.get("room:1")?.emit("message", { body: "buffered" });
      expect(onMessage).not.toHaveBeenCalled();

      // The room is torn down (e.g. by reconciliation) before it ever
      // settles — removing the last pending topic finalizes the generation
      // and flushes the buffer.
      await transport.leave("room:1");
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The left topic's already-queued event must not fire against a
      // handler that no longer has a live subscription.
      expect(onMessage).not.toHaveBeenCalled();
    });

    it("does not deliver an old generation to an observer registered by a later session", async () => {
      const transport = new PhoenixChannelsTransport({
        wsUrl: "wss://example.test/socket",
        apiKey: "key-1",
      });
      await transport.connect();
      await transport.join("room:1", {});

      let releaseOldObserver: (() => void) | undefined;
      const oldObserverReleased = new Promise<void>((resolve) => {
        releaseOldObserver = resolve;
      });
      const oldObserver = vi.fn(async () => oldObserverReleased);
      const unregisterOldObserver = transport.onReconnected(oldObserver);

      const socket = phoenixMock.FakeSocket.instances[0];
      socket?.emitOpen();
      socket?.channels.get("room:1")?.settleRejoin("ok");
      await vi.waitFor(() => expect(oldObserver).toHaveBeenCalledTimes(1));

      unregisterOldObserver();
      await transport.disconnect();
      await transport.connect();
      const newObserver = vi.fn();
      transport.onReconnected(newObserver);

      releaseOldObserver?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(newObserver).not.toHaveBeenCalled();
    });
  });
});
