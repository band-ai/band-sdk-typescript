import { describe, expect, it, vi } from "vitest";

import { PhoenixChannelsTransport } from "../src/platform/streaming/PhoenixChannelsTransport";

describe("inbound frame limit", () => {
  it("classifies oversize inbound frames as terminal disconnects before decode", async () => {
    const listeners: Array<(event: MessageEvent<unknown>) => void> = [];

    class FakeWebSocket {
      public static readonly instances: FakeWebSocket[] = [];
      public closed = false;

      public constructor(_address: string | URL, _protocols?: string | string[]) {
        FakeWebSocket.instances.push(this);
      }

      public addEventListener(
        type: string,
        listener: (event: MessageEvent<unknown>) => void,
      ): void {
        if (type === "message") {
          listeners.push(listener);
        }
      }

      public close(): void {
        this.closed = true;
      }
    }

    const onTerminal = vi.fn();
    const transport = new PhoenixChannelsTransport({
      wsUrl: "wss://example.test/socket",
      apiKey: "key-1",
      websocketFactory: FakeWebSocket as unknown as typeof WebSocket,
      reconnectAfterMs: () => Number.POSITIVE_INFINITY,
      onTerminalDisconnect: onTerminal,
    });

    const connect = transport.connect();
    await vi.waitFor(() => {
      expect(FakeWebSocket.instances.length).toBeGreaterThan(0);
    });
    const oversize = "x".repeat(65_537);
    const event = {
      data: oversize,
      stopImmediatePropagation: vi.fn(),
    } as unknown as MessageEvent<unknown>;
    listeners[0]?.(event);
    expect(event.stopImmediatePropagation).toHaveBeenCalled();
    expect(onTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "inbound_frame",
        code: "websocket.oversize_frame",
        retryable: false,
      }),
    );
    transport.disconnect().catch(() => undefined);
    connect.catch(() => undefined);
  });
});
