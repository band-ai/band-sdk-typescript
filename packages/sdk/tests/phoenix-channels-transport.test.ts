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
    private pendingLeaveCallbacks: Map<Outcome, (payload?: unknown) => void> | null = null;
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

    public off(event: string, _ref?: number): void {
      this.handlers.delete(event);
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
      if (this.leaveOutcome === "pending") {
        const callbacks = new Map<Outcome, (payload?: unknown) => void>();
        this.pendingLeaveCallbacks = callbacks;
        const chain = {
          receive: (kind: Outcome, callback: (payload?: unknown) => void) => {
            callbacks.set(kind, callback);
            return chain;
          },
        };
        return chain;
      }
      return this.receiver(this.leaveOutcome);
    }

    /** Settles a `leave()` call left pending via `leaveOutcome = "pending"`. */
    public settleLeave(outcome: Exclude<Outcome, "pending">): void {
      const callbacks = this.pendingLeaveCallbacks;
      this.pendingLeaveCallbacks = null;
      callbacks?.get(outcome)?.(outcome === "ok" ? {} : { error: outcome });
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

  it("coalesces concurrent join() calls for the same never-before-joined topic into one physical join", async () => {
    const transport = new PhoenixChannelsTransport({
      wsUrl: "wss://example.test/socket",
      apiKey: "key-1",
    });
    await transport.connect();

    const first = transport.join("room:1", {});
    const second = transport.join("room:1", {});
    await Promise.all([first, second]);

    const socket = phoenixMock.FakeSocket.instances[0];
    expect(socket?.channels.filter((channel) => channel.topic === "room:1")).toHaveLength(1);
  });

  it("coalesces two joins for the same topic that both arrive while a reconnect barrier is open", async () => {
    const transport = new PhoenixChannelsTransport({
      wsUrl: "wss://example.test/socket",
      apiKey: "key-1",
    });
    await transport.connect();
    await transport.join("room:1", {});

    const socket = phoenixMock.FakeSocket.instances[0];
    // A later automatic reconnect opens the barrier; room:1 is the only
    // topic the new generation must wait on to settle.
    socket?.emitOpen();

    const first = transport.join("room:2", {});
    const second = transport.join("room:2", {});

    // Both calls are queued behind the barrier — neither has created a
    // channel for room:2 yet.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(socket?.channels.filter((channel) => channel.topic === "room:2")).toHaveLength(0);

    socket?.channels.get("room:1")?.settleRejoin("ok");
    await Promise.all([first, second]);

    // The second caller resumed from the barrier and coalesced onto the
    // first's already-registered in-flight join, rather than starting its
    // own independent doJoin() and creating a second channel.
    expect(socket?.channels.filter((channel) => channel.topic === "room:2")).toHaveLength(1);
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
    await Promise.resolve(); // let doJoin's synchronous prefix run
    const staleChannel = socket?.channels.get("room:late");

    await transport.disconnect();
    // The in-flight join's channel is detached immediately by disconnect()
    // (see "does not leak events..." below), not left dangling in Phoenix's
    // own registry — so it's already gone from the socket's channel list.
    expect(socket?.channels.has("room:late")).toBe(false);

    socket?.joinOutcomes.delete("room:late");
    await transport.connect();
    const freshJoin = transport.join("room:late", {});
    await expect(freshJoin).resolves.toBeUndefined();

    // Settling the original (now-detached) channel's own join push still
    // reaches doJoin's stale-epoch check and rejects, even though the
    // channel itself is no longer registered anywhere.
    staleChannel?.settleRejoin("ok");
    await expect(staleJoin).rejects.toThrow("superseded by transport disconnect");
    expect(socket?.channels.has("room:late")).toBe(true); // the fresh join's own channel
  });

  it("does not leak events from a join that was still in flight when disconnect() ran", async () => {
    const onMessage = vi.fn(async () => {});
    const transport = new PhoenixChannelsTransport({
      wsUrl: "wss://example.test/socket",
      apiKey: "key-1",
    });
    await transport.connect();

    const socket = phoenixMock.FakeSocket.instances[0];
    socket?.joinOutcomes.set("room:late", "pending");
    const staleJoin = transport.join("room:late", { message: onMessage });
    staleJoin.catch(() => undefined);
    await Promise.resolve(); // let doJoin's synchronous prefix run

    const inFlightChannel = socket?.channels.get("room:late");
    expect(inFlightChannel).toBeDefined();

    await transport.disconnect();

    // Detached, not merely forgotten by this transport's own bookkeeping —
    // otherwise Phoenix's own reconnect machinery could later resurrect this
    // channel and redeliver events on it with no dedup anywhere upstream.
    expect(socket?.channels.has("room:late")).toBe(false);
    inFlightChannel?.emit("message", { body: "leaked-after-disconnect" });
    await Promise.resolve();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("does not let a superseded join's late settlement evict a newer join's still-pending entry for the same topic", async () => {
    const transport = new PhoenixChannelsTransport({
      wsUrl: "wss://example.test/socket",
      apiKey: "key-1",
    });
    await transport.connect();

    const socket = phoenixMock.FakeSocket.instances[0];
    socket?.joinOutcomes.set("room:late", "pending");
    const firstJoin = transport.join("room:late", {});
    firstJoin.catch(() => undefined);
    await Promise.resolve(); // let doJoin's synchronous prefix run
    const firstChannel = socket?.channels.get("room:late");

    await transport.disconnect();
    expect(firstChannel?.leaveCallCount).toBe(1);

    // Reconnect and start a second join for the same topic while it's still
    // pending too — disconnect() cleared `joinFlights`, so this is a
    // genuinely new join, not coalesced with the first.
    await transport.connect();
    const secondJoin = transport.join("room:late", {});
    secondJoin.catch(() => undefined);
    await Promise.resolve();
    const secondChannel = socket?.channels.get("room:late");
    expect(secondChannel).not.toBe(firstChannel);

    // The first join's own Push finally settles late. It must still reject
    // as superseded, but must not touch the second join's still-pending
    // slot or abandon the first channel a second time.
    firstChannel?.settleRejoin("ok");
    await expect(firstJoin).rejects.toThrow("superseded by transport disconnect");
    expect(firstChannel?.leaveCallCount).toBe(1);

    // Proof the second join's channel is still correctly tracked as
    // pending: a disconnect now must abandon it, not silently miss it.
    await transport.disconnect();
    expect(secondChannel?.leaveCallCount).toBe(1);
  });

  it("does not let a superseded join's late error settlement double-abandon its own channel or evict a newer join's still-pending entry", async () => {
    const transport = new PhoenixChannelsTransport({
      wsUrl: "wss://example.test/socket",
      apiKey: "key-1",
    });
    await transport.connect();

    const socket = phoenixMock.FakeSocket.instances[0];
    socket?.joinOutcomes.set("room:late", "pending");
    const firstJoin = transport.join("room:late", {});
    firstJoin.catch(() => undefined);
    await Promise.resolve();
    const firstChannel = socket?.channels.get("room:late");

    await transport.disconnect();
    expect(firstChannel?.leaveCallCount).toBe(1);

    await transport.connect();
    const secondJoin = transport.join("room:late", {});
    secondJoin.catch(() => undefined);
    await Promise.resolve();
    const secondChannel = socket?.channels.get("room:late");
    expect(secondChannel).not.toBe(firstChannel);

    // The first join's own Push finally settles late with an ERROR — this
    // exercises the identity check in doJoin's catch block (as opposed to
    // the prior test's post-await success path). It must reject with the
    // real join failure, not double-abandon its own already-abandoned
    // channel, and must not touch the second join's still-pending slot.
    firstChannel?.settleRejoin("error");
    await expect(firstJoin).rejects.toThrow("Failed to join topic room:late");
    expect(firstChannel?.leaveCallCount).toBe(1);

    await transport.disconnect();
    expect(secondChannel?.leaveCallCount).toBe(1);
  });

  it("does not report a topic as already joined while its leave is still in flight", async () => {
    const transport = new PhoenixChannelsTransport({
      wsUrl: "wss://example.test/socket",
      apiKey: "key-1",
    });
    await transport.connect();
    await transport.join("room:1", {});

    const socket = phoenixMock.FakeSocket.instances[0];
    const oldChannel = socket?.channels.get("room:1");
    if (oldChannel) {
      oldChannel.leaveOutcome = "pending";
    }

    const leave = transport.leave("room:1");
    await Promise.resolve();

    let secondJoinResolved = false;
    const secondJoin = transport.join("room:1", {}).then(() => {
      secondJoinResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The old channel is still registered (its leave hasn't settled) — a
    // buggy `existingJoin()` would treat that as "already joined" and
    // resolve the second join immediately, without ever creating a real
    // channel for it.
    expect(secondJoinResolved).toBe(false);

    oldChannel?.settleLeave("ok");
    await leave;
    await secondJoin;

    // A real new join happened — a second FakeChannel for the topic was
    // created via `socket.channel()` — rather than the second join()
    // resolving off the stale registry entry with no real work done.
    // (The old channel is never removed from the fake socket's own list on
    // a graceful leave — matching real Phoenix's socket.remove() contract,
    // which this transport also only calls for an abandoned/failed channel
    // — so both instances coexist here; `.filter` finds them both.)
    expect(secondJoinResolved).toBe(true);
    const channelsForTopic = socket?.channels.filter((channel) => channel.topic === "room:1");
    expect(channelsForTopic).toHaveLength(2);
    expect(channelsForTopic?.[1]).not.toBe(oldChannel);
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

    it("includes agent_control in the reconnect snapshot alongside room topics, matching production's always-set agentId", async () => {
      const transport = new PhoenixChannelsTransport({
        wsUrl: "wss://example.test/socket",
        apiKey: "key-1",
        agentId: "agent-1",
      });
      await transport.connect();
      await transport.join("room:1", {});

      const observer = vi.fn();
      transport.onReconnected(observer);

      const socket = phoenixMock.FakeSocket.instances[0];
      socket?.emitOpen();
      socket?.channels.get("room:1")?.settleRejoin("ok");
      socket?.channels.get("agent_control:agent-1")?.settleRejoin("ok");

      await vi.waitFor(() => expect(observer).toHaveBeenCalledTimes(1));
      expect(observer).toHaveBeenCalledWith({
        generation: 1,
        attemptedTopics: new Set(["room:1", "agent_control:agent-1"]),
        joinedTopics: new Set(["room:1", "agent_control:agent-1"]),
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

    it("finalizes an incomplete generation superseded by a newer open, so nothing awaiting it hangs, then finalizes the new one too", async () => {
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
      await new Promise((resolve) => setTimeout(resolve, 0));

      socket?.emitOpen();

      // The superseded first generation is finalized immediately, with
      // room:2 correctly excluded from its joined set.
      await vi.waitFor(() => expect(observer).toHaveBeenCalledTimes(1));
      expect(observer).toHaveBeenNthCalledWith(1, {
        generation: 1,
        attemptedTopics: new Set(["room:1", "room:2"]),
        joinedTopics: new Set(["room:1"]),
      });

      socket?.channels.get("room:1")?.settleRejoin("ok");
      socket?.channels.get("room:2")?.settleRejoin("ok");

      await vi.waitFor(() => expect(observer).toHaveBeenCalledTimes(2));
      expect(observer).toHaveBeenNthCalledWith(2, {
        generation: 2,
        attemptedTopics: new Set(["room:1", "room:2"]),
        joinedTopics: new Set(["room:1", "room:2"]),
      });
    });

    it("logs a reconnect observer failure instead of leaking an unhandled rejection, and still flushes buffered events afterward", async () => {
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const onMessage = vi.fn();
      const transport = new PhoenixChannelsTransport({
        wsUrl: "wss://example.test/socket",
        apiKey: "key-1",
        logger,
      });
      await transport.connect();
      await transport.join("room:1", { message_created: onMessage });

      const failure = new Error("observer boom");
      transport.onReconnected(() => {
        throw failure;
      });

      const socket = phoenixMock.FakeSocket.instances[0];
      socket?.emitOpen();
      socket?.channels.get("room:1")?.emit("message_created", { id: "buffered-1" });
      expect(onMessage).not.toHaveBeenCalled();

      socket?.channels.get("room:1")?.settleRejoin("ok");

      await vi.waitFor(() =>
        expect(logger.error).toHaveBeenCalledWith(
          "Reconnect observer failed",
          expect.objectContaining({ generation: 1, error: failure }),
        ),
      );

      // The failing observer must not wedge the transport in buffering
      // state forever: the event it buffered still gets delivered once the
      // generation finishes settling.
      await vi.waitFor(() => expect(onMessage).toHaveBeenCalledWith({ id: "buffered-1" }));
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
