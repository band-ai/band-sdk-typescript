import { beforeEach, describe, expect, it, vi } from "vitest";

import { GenericAdapter } from "../src/adapters/GenericAdapter";
import { TransportError } from "../src/core/errors";
import { ThenvoiLink } from "../src/platform/ThenvoiLink";
import { WebSocketDisconnectError } from "../src/platform/streaming/disconnectReason";
import { PlatformRuntime } from "../src/runtime/PlatformRuntime";
import { FakeRestApi } from "./testUtils";

const phoenixMock = vi.hoisted(() => {
  type Outcome = "ok" | "error" | "timeout" | "pending";

  class FakeChannel {
    public readonly topic: string;
    public readonly handlers = new Map<
      string,
      (payload: Record<string, unknown>) => void
    >();
    public joinOutcome: Outcome = "ok";
    public leaveOutcome: Outcome = "ok";
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

    public join(): {
      receive: (
        kind: Outcome,
        callback: (payload?: unknown) => void,
      ) => unknown;
    } {
      return this.receiver(this.joinOutcome);
    }

    public leave(): {
      receive: (
        kind: Outcome,
        callback: (payload?: unknown) => void,
      ) => unknown;
    } {
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

    public disconnect(): void {
      this.disconnectCount += 1;
      this.closeHandler?.();
    }

    public emitClose(event?: { code?: number; reason?: string }): void {
      this.closeHandler?.(event);
    }

    public channel(topic: string): FakeChannel {
      const channel = new FakeChannel(topic);
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

  it("passes ThenvoiLink conflict policy into the socket params", () => {
    new ThenvoiLink({
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

      if (status === 429 || status === 503) {
        await expect(connectPromise).resolves.toBeUndefined();
      } else {
        await expect(connectPromise).rejects.toBeInstanceOf(
          WebSocketDisconnectError,
        );
      }
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

    await expect(connectPromise).resolves.toBeUndefined();
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
      link: new ThenvoiLink({
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
});
