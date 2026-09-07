import { describe, expect, it, vi } from "vitest";

import { TransportError } from "../src/core/errors";
import { PhoenixChannelsTransport } from "../src/platform/streaming/PhoenixChannelsTransport";
import {
  PHOENIX_MANUAL_TIMER_MS,
  REALTIME_MAX_REFS,
} from "../src/platform/streaming/resourceLimits";

class FakeWebSocket {
  public static readonly instances: FakeWebSocket[] = [];
  public static readonly CONNECTING = 0;
  public static readonly OPEN = 1;
  public static readonly CLOSING = 2;
  public static readonly CLOSED = 3;
  public readyState = FakeWebSocket.CONNECTING;
  public sent: string[] = [];
  public onopen: ((event?: unknown) => void) | null = null;
  public onclose: ((event?: { code?: number; reason?: string }) => void) | null =
    null;
  public onerror: ((event?: unknown) => void) | null = null;
  public onmessage: ((event: { data: string }) => void) | null = null;

  public constructor(_url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
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
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  public addEventListener(): void {}
}

function createTransport() {
  FakeWebSocket.instances.splice(0, FakeWebSocket.instances.length);
  return new PhoenixChannelsTransport({
    wsUrl: "wss://example.test/socket",
    apiKey: "key-1",
    websocketFactory: FakeWebSocket as unknown as typeof WebSocket,
    reconnectMode: "manual",
    joinAgentControl: false,
    heartbeatIntervalMs: 20,
  });
}

describe("phoenix manual reconnect ownership", () => {
  it("uses a finite timer and one channel per topic after two closes", async () => {
    const transport = createTransport();
    expect(transport.getReconnectTimerMs(1)).toBe(PHOENIX_MANUAL_TIMER_MS);
    expect(Number.isFinite(transport.getReconnectTimerMs(1))).toBe(true);

    await transport.connect();
    await transport.join("chat_room:room-1", { ping: () => undefined });
    expect(
      transport.getSocketChannelTopics().filter((topic) => topic === "chat_room:room-1"),
    ).toHaveLength(1);

    FakeWebSocket.instances.at(-1)?.close(1006, "drop");
    await vi.waitFor(() => {
      expect(transport.isConnected()).toBe(false);
    });
    expect(
      transport.getSocketChannelTopics().filter((topic) => topic === "chat_room:room-1"),
    ).toHaveLength(0);

    await transport.connect();
    await transport.join("chat_room:room-1", { ping: () => undefined });
    FakeWebSocket.instances.at(-1)?.close(1006, "drop-2");
    await vi.waitFor(() => expect(transport.isConnected()).toBe(false));
    await transport.connect();
    await transport.join("chat_room:room-1", { ping: () => undefined });
    expect(
      transport.getSocketChannelTopics().filter((topic) => topic === "chat_room:room-1"),
    ).toHaveLength(1);
    await transport.disconnect();
  });

  it("counts real Socket.makeRef including heartbeat and leave", async () => {
    const transport = createTransport();
    await transport.connect();
    const afterConnect = transport.getProtocolRefCount();
    expect(afterConnect).toBeGreaterThan(0);
    await transport.join("topic:a", { ping: () => undefined });
    const afterJoin = transport.getProtocolRefCount();
    expect(afterJoin).toBeGreaterThan(afterConnect);
    await vi.waitFor(() => {
      expect(transport.getProtocolRefCount()).toBeGreaterThan(afterJoin);
    });
    await transport.leave("topic:a");
    expect(transport.getProtocolRefCount()).toBeGreaterThan(afterJoin);
    expect(transport.getProtocolRefCount()).toBeLessThanOrEqual(REALTIME_MAX_REFS);
    await transport.disconnect();
  });

  it("keeps default-mode topics after Phoenix reconnects", async () => {
    FakeWebSocket.instances.splice(0, FakeWebSocket.instances.length);
    const transport = new PhoenixChannelsTransport({
      wsUrl: "wss://example.test/socket",
      apiKey: "key-1",
      agentId: "agent-1",
      websocketFactory: FakeWebSocket as unknown as typeof WebSocket,
      reconnectAfterMs: () => 10,
      heartbeatIntervalMs: 60_000,
    });
    const seen: string[] = [];
    await transport.connect();
    await transport.join("agent_rooms:agent-1", {
      room_added: (payload) => {
        seen.push(String(payload.id ?? ""));
      },
    });
    expect(transport.getSocketChannelTopics()).toEqual(
      expect.arrayContaining(["agent_control:agent-1", "agent_rooms:agent-1"]),
    );
    FakeWebSocket.instances.at(-1)?.close(1006, "drop");
    await vi.waitFor(() => {
      expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
    });
    await vi.waitFor(() => {
      expect(transport.isConnected()).toBe(true);
    });
    expect(
      transport.getSocketChannelTopics().filter((topic) => topic === "agent_rooms:agent-1"),
    ).toHaveLength(1);
    expect(
      transport.getSocketChannelTopics().filter((topic) => topic === "agent_control:agent-1"),
    ).toHaveLength(1);
    const socket = FakeWebSocket.instances.at(-1);
    socket?.onmessage?.({
      data: JSON.stringify([null, "1", "agent_rooms:agent-1", "room_added", { id: "room-live" }]),
    });
    await vi.waitFor(() => {
      expect(seen).toContain("room-live");
    });
    await transport.disconnect();
  });

  it("aborts waitForConnection without hanging", async () => {
    const abort = new AbortController();
    const transport = new PhoenixChannelsTransport({
      wsUrl: "wss://example.test/socket",
      apiKey: "key-1",
      websocketFactory: class {
        public readyState = 0;
        public onopen: (() => void) | null = null;
        public onclose: (() => void) | null = null;
        public onerror: (() => void) | null = null;
        public onmessage: (() => void) | null = null;
        public send(): void {}
        public close(): void {
          this.readyState = 3;
          this.onclose?.();
        }
        public addEventListener(): void {}
      } as unknown as typeof WebSocket,
      reconnectMode: "manual",
      joinAgentControl: false,
      abortSignal: abort.signal,
    });
    const pending = transport.connect();
    abort.abort();
    await expect(pending).rejects.toBeInstanceOf(TransportError);
    await transport.disconnect().catch(() => undefined);
  });
});
