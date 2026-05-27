import { beforeEach, describe, expect, it, vi } from "vitest";

import { TransportError } from "../src/core/errors";

const wsMock = vi.hoisted(() => {
  interface FakeNodeWebSocketOptions {
    headers?: Record<string, string>;
  }

  class FakeNodeWebSocket {
    public static readonly instances: FakeNodeWebSocket[] = [];

    public readonly url: string | URL;
    public readonly protocols?: string | string[];
    public readonly options?: FakeNodeWebSocketOptions;

    public constructor(
      url: string | URL,
      protocols?: string | string[],
      options?: FakeNodeWebSocketOptions,
    ) {
      this.url = url;
      this.protocols = protocols;
      this.options = options;
      FakeNodeWebSocket.instances.push(this);
    }
  }

  return {
    FakeNodeWebSocket,
    reset: () => {
      FakeNodeWebSocket.instances.splice(0, FakeNodeWebSocket.instances.length);
    },
  };
});

const phoenixMock = vi.hoisted(() => {
  type Outcome = "ok" | "error" | "timeout";

  interface FakeSocketOptions {
    params?: Record<string, unknown>;
    heartbeatIntervalMs?: number;
    reconnectAfterMs?: (tries: number) => number;
    transport?: typeof WebSocket;
  }

  const PHOENIX_WEBSOCKET_SUFFIX = "/websocket";
  const PHOENIX_VSN = "2.0.0";

  class FakeChannel {
    public readonly topic: string;
    public readonly handlers = new Map<string, (payload: Record<string, unknown>) => void>();
    public joinOutcome: Outcome = "ok";
    public leaveOutcome: Outcome = "ok";
    private nextRef = 1;

    public constructor(topic: string) {
      this.topic = topic;
    }

    public on(event: string, handler: (payload: Record<string, unknown>) => void): number {
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
      receive: (kind: Outcome, callback: (payload?: unknown) => void) => unknown;
    } {
      return this.receiver(this.joinOutcome);
    }

    public leave(): {
      receive: (kind: Outcome, callback: (payload?: unknown) => void) => unknown;
    } {
      return this.receiver(this.leaveOutcome);
    }

    private receiver(outcome: Outcome): {
      receive: (kind: Outcome, callback: (payload?: unknown) => void) => unknown;
    } {
      const chain = {
        receive: (kind: Outcome, callback: (payload?: unknown) => void) => {
          if (kind === outcome) {
            queueMicrotask(() => callback(kind === "ok" ? {} : { error: kind }));
          }
          return chain;
        },
      };
      return chain;
    }
  }

  class FakeSocket {
    public static readonly instances: FakeSocket[] = [];

    public readonly url: string;
    public readonly options: FakeSocketOptions;
    public readonly channels = new Map<string, FakeChannel>();
    private openHandler: (() => void) | null = null;
    private closeHandler: (() => void) | null = null;
    private errorHandler: ((payload: unknown) => void) | null = null;

    public constructor(url: string, options: FakeSocketOptions) {
      this.url = url;
      this.options = options;
      FakeSocket.instances.push(this);
    }

    public onOpen(handler: () => void): void {
      this.openHandler = handler;
    }

    public onClose(handler: () => void): void {
      this.closeHandler = handler;
    }

    public onError(handler: (payload: unknown) => void): void {
      this.errorHandler = handler;
    }

    public connect(): void {
      const WebSocketTransport = this.options.transport;
      if (WebSocketTransport) {
        new WebSocketTransport(this.buildWebSocketUrl(), ["phoenix"]);
      }

      queueMicrotask(() => {
        this.openHandler?.();
      });
    }

    public disconnect(): void {
      this.closeHandler?.();
    }

    public channel(topic: string): FakeChannel {
      const channel = new FakeChannel(topic);
      this.channels.set(topic, channel);
      return channel;
    }

    public emitError(payload: unknown): void {
      this.errorHandler?.(payload);
    }

    private buildWebSocketUrl(): string {
      const parsed = new URL(this.url);
      if (!parsed.pathname.endsWith(PHOENIX_WEBSOCKET_SUFFIX)) {
        parsed.pathname = `${parsed.pathname}${PHOENIX_WEBSOCKET_SUFFIX}`;
      }
      for (const [key, value] of Object.entries(this.options.params ?? {})) {
        parsed.searchParams.set(key, String(value));
      }
      parsed.searchParams.set("vsn", PHOENIX_VSN);
      return parsed.toString();
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

vi.mock("ws", () => ({
  WebSocket: wsMock.FakeNodeWebSocket,
}));

vi.mock("phoenix", () => ({
  Channel: phoenixMock.FakeChannel,
  Socket: phoenixMock.FakeSocket,
}));

import { PhoenixChannelsTransport } from "../src/platform/streaming/PhoenixChannelsTransport";

describe("PhoenixChannelsTransport", () => {
  beforeEach(() => {
    phoenixMock.reset();
    wsMock.reset();
  });

  it("normalizes websocket URL and connects once", async () => {
    const transport = new PhoenixChannelsTransport({
      wsUrl: "wss://example.test/socket/websocket",
      apiKey: "key-1",
      agentId: "agent-1",
    });

    const socket = phoenixMock.FakeSocket.instances[0];
    expect(socket?.url).toBe("wss://example.test/socket");

    await transport.connect();
    await transport.connect();
    expect(transport.isConnected()).toBe(true);
  });

  it("omits agent_id params when no agent id is configured", async () => {
    const transport = new PhoenixChannelsTransport({
      wsUrl: "wss://example.test/socket",
      apiKey: "key-1",
    });

    await transport.connect();

    const socket = phoenixMock.FakeSocket.instances[0];
    expect(socket?.options.params).toEqual({});
    const websocket = wsMock.FakeNodeWebSocket.instances[0];
    expect(String(websocket?.url)).toBe("wss://example.test/socket/websocket?vsn=2.0.0");
    expect(String(websocket?.url)).not.toContain("agent_id=undefined");
  });

  it("sends API keys with x-api-key headers instead of Phoenix params", async () => {
    const transport = new PhoenixChannelsTransport({
      wsUrl: "wss://example.test/socket/websocket?api_key=stale-key&debug=true",
      apiKey: "key-1",
      agentId: "agent-1",
    });

    await transport.connect();

    const socket = phoenixMock.FakeSocket.instances[0];
    expect(socket?.url).toBe("wss://example.test/socket?debug=true");
    expect(socket?.options.params).toEqual({ agent_id: "agent-1" });
    expect(socket?.options.params).not.toHaveProperty("api_key");

    const websocket = wsMock.FakeNodeWebSocket.instances[0];
    expect(String(websocket?.url)).toBe(
      "wss://example.test/socket/websocket?debug=true&agent_id=agent-1&vsn=2.0.0",
    );
    expect(String(websocket?.url)).not.toMatch(/[?&]api_key=/);
    expect(websocket?.options?.headers).toEqual({ "x-api-key": "key-1" });
  });

  it("keeps reconnect handshakes header-authenticated", async () => {
    const transport = new PhoenixChannelsTransport({
      wsUrl: "wss://example.test/socket?api_key=stale-key",
      apiKey: "key-1",
      agentId: "agent-1",
    });

    await transport.connect();
    phoenixMock.FakeSocket.instances[0]?.disconnect();
    await transport.connect();

    expect(wsMock.FakeNodeWebSocket.instances).toHaveLength(2);
    for (const websocket of wsMock.FakeNodeWebSocket.instances) {
      expect(String(websocket.url)).not.toMatch(/[?&]api_key=/);
      expect(websocket.options?.headers).toEqual({ "x-api-key": "key-1" });
    }
  });

  it("wraps custom websocket factories with x-api-key headers", async () => {
    interface CustomWebSocketOptions {
      headers?: Record<string, string>;
    }

    class CustomWebSocket {
      public static readonly instances: CustomWebSocket[] = [];
      public readonly url: string | URL;
      public readonly options?: CustomWebSocketOptions;

      public constructor(
        url: string | URL,
        _protocols?: string | string[],
        options?: CustomWebSocketOptions,
      ) {
        this.url = url;
        this.options = options;
        CustomWebSocket.instances.push(this);
      }
    }

    const transport = new PhoenixChannelsTransport({
      wsUrl: "wss://example.test/socket",
      apiKey: "key-1",
      agentId: "agent-1",
      websocketFactory: CustomWebSocket as unknown as typeof WebSocket,
    });

    await transport.connect();

    const socket = phoenixMock.FakeSocket.instances[0];
    expect(socket?.options.params).toEqual({ agent_id: "agent-1" });
    expect(socket?.options.params).not.toHaveProperty("api_key");
    expect(CustomWebSocket.instances[0]?.options?.headers).toEqual({
      "x-api-key": "key-1",
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
});
