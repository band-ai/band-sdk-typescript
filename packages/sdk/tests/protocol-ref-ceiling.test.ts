import { describe, expect, it, vi } from "vitest";

import { PhoenixChannelsTransport } from "../src/platform/streaming/PhoenixChannelsTransport";

class FakeWebSocket {
  public static readonly instances: FakeWebSocket[] = [];
  public readyState = 0;
  public onopen: (() => void) | null = null;
  public onclose: ((event?: { code?: number; reason?: string }) => void) | null =
    null;
  public onerror: ((event?: unknown) => void) | null = null;
  public onmessage: ((event: { data: string }) => void) | null = null;
  public sent: string[] = [];

  public constructor(_url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }

  public send(data: string): void {
    this.sent.push(data);
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!Array.isArray(parsed) || parsed[3] !== "phx_join") {
      return;
    }
    const [joinRef, ref, topic] = parsed as [string, string, string, string, unknown];
    queueMicrotask(() => {
      this.onmessage?.({
        data: JSON.stringify([
          joinRef,
          ref,
          topic,
          "phx_reply",
          { status: "ok", response: {} },
        ]),
      });
    });
  }

  public close(code = 1000, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  public addEventListener(): void {}
}

describe("protocol ref ceiling", () => {
  it("goes terminal on heartbeat/join/leave without throwing", async () => {
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent): void => {
      errors.push(event.error ?? event.message);
    };
    process.on("uncaughtException", onError as never);
    const onTerminal = vi.fn();
    FakeWebSocket.instances.splice(0, FakeWebSocket.instances.length);
    const transport = new PhoenixChannelsTransport({
      wsUrl: "wss://example.test/socket",
      apiKey: "key-1",
      websocketFactory: FakeWebSocket as unknown as typeof WebSocket,
      reconnectMode: "manual",
      joinAgentControl: false,
      heartbeatIntervalMs: 20,
      maxProtocolRefs: 6,
      onTerminalDisconnect: onTerminal,
    });
    await transport.connect();
    await transport.join("topic:a", { ping: () => undefined }).catch(() => undefined);
    await vi.waitFor(() => {
      expect(onTerminal).toHaveBeenCalled();
    });
    const count = transport.getProtocolRefCount();
    await transport.leave("topic:a").catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(transport.getProtocolRefCount()).toBe(count);
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(transport.getReconnectTimerMs(1)).toBe(2_147_483_647);
    expect(errors).toHaveLength(0);
    process.off("uncaughtException", onError as never);
    await transport.disconnect().catch(() => undefined);
  });
});
