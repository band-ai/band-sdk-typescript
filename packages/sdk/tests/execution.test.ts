import { afterEach, describe, expect, it, vi } from "vitest";

import { RecoverableTurnError } from "../src/core/errors";
import type { PlatformEvent } from "../src/platform/events";
import { Execution } from "../src/runtime/Execution";
import type { ExecutionState } from "../src/runtime/ExecutionContext";
import { RetryTracker } from "@band-ai/band-sdk-core";

interface BacklogMessage {
  id: string;
  roomId: string;
  content: string;
  senderId: string;
  senderType: string;
  senderName: string | null;
  messageType: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

function makeEvent(id: string): PlatformEvent {
  return {
    type: "message_created",
    roomId: "room-1",
    payload: {
      id,
      content: "hello",
      message_type: "text",
      sender_id: "user-1",
      sender_type: "User",
      sender_name: "User One",
      metadata: {},
      inserted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  };
}

function makeReconnectedEvent(): PlatformEvent {
  return { type: "reconnected", roomId: null, payload: {} };
}

function makeBacklogMessage(id: string, content = "backlog"): BacklogMessage {
  return {
    id,
    roomId: "room-1",
    content,
    senderId: "user-1",
    senderType: "User",
    senderName: "User One",
    messageType: "text",
    metadata: {},
    createdAt: new Date("2026-03-05T00:00:00.000Z"),
  };
}

function makeContext(maxRetries = 1) {
  const states: ExecutionState[] = [];
  const retryTracker = new RetryTracker(maxRetries);
  return {
    setState(state: ExecutionState) {
      states.push(state);
    },
    getRetryTracker() {
      return retryTracker;
    },
    states,
    retryTracker,
  };
}

function createExecution(options?: {
  onExecute?: (event: PlatformEvent) => Promise<void>;
  getNextMessage?: () => Promise<BacklogMessage | null>;
  getStaleProcessingMessages?: () => Promise<BacklogMessage[]>;
  markFailed?: (roomId: string, messageId: string, error: string, opts?: unknown) => Promise<void>;
  maxRetries?: number;
}) {
  const context = makeContext(options?.maxRetries);
  const processed: string[] = [];
  const execution = new Execution({
    roomId: "room-1",
    link: {
      getNextMessage: options?.getNextMessage ?? (async () => null),
      getStaleProcessingMessages: options?.getStaleProcessingMessages ?? (async () => []),
      markFailed: options?.markFailed ?? (async () => {}),
    } as never,
    context: context as never,
    onExecute: async (_context, event) => {
      if (event.type === "message_created") {
        processed.push(event.payload.id);
      }
      await options?.onExecute?.(event);
    },
  });

  return {
    context,
    processed,
    execution,
  };
}

describe("Execution", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("stops processing and surfaces handler failures", async () => {
    let failFirst = true;
    const { execution, processed } = createExecution({
      onExecute: async () => {
        if (failFirst) {
          failFirst = false;
          throw new Error("boom");
        }
      },
    });

    await execution.enqueue(makeEvent("m1"));
    await execution.enqueue(makeEvent("m2"));
    await expect(execution.waitUntilStopped()).rejects.toThrow("boom");
    expect(processed).toEqual(["m1"]);
    await expect(execution.stop()).rejects.toThrow("boom");
  });

  it("keeps serving the room when one turn fails recoverably", async () => {
    // The contrast with the test above is the point. A reply that could not be
    // posted fails its own turn — the message is already marked failed by the
    // time we get here — and the queued messages behind it are unrelated. Only
    // a failure the room cannot recover from should cost the room its loop,
    // and through onFailure, the whole runtime.
    const { execution, processed } = createExecution({
      onExecute: async (event) => {
        if (event.type === "message_created" && event.payload.id === "m1") {
          throw new RecoverableTurnError("could not post the reply");
        }
      },
    });

    await execution.enqueue(makeEvent("m1"));
    await execution.enqueue(makeEvent("m2"));
    await execution.stop();

    expect(processed).toEqual(["m1", "m2"]);
  });

  it("sets state to processing then idle around execution", async () => {
    const { execution, context } = createExecution();

    await execution.enqueue(makeEvent("m1"));
    await execution.waitForIdle();
    expect(context.states).toEqual(["processing", "idle"]);
    await execution.stop();
  });

  it("waitForIdle resolves immediately when there is no backlog or queued work", async () => {
    const { execution } = createExecution();

    await expect(execution.waitForIdle()).resolves.toBe(true);
    await execution.stop();
  });

  it("waitForIdle with timeout returns false when processing takes too long", async () => {
    const { execution } = createExecution({
      onExecute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
      },
    });

    await execution.enqueue(makeEvent("m1"));
    await expect(execution.waitForIdle(10)).resolves.toBe(false);
    const idleWaiters = (execution as unknown as { idleWaiters: Set<() => void> }).idleWaiters;
    expect(idleWaiters.size).toBe(0);
    await expect(execution.waitForIdle(500)).resolves.toBe(true);
    await execution.stop();
  });

  it("waitForIdle clears timeout when idle resolves first", async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
    const { execution } = createExecution({
      onExecute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    });

    await execution.enqueue(makeEvent("m1"));
    const idlePromise = execution.waitForIdle(1_000);
    await vi.advanceTimersByTimeAsync(20);
    await expect(idlePromise).resolves.toBe(true);
    expect(clearTimeoutSpy).toHaveBeenCalled();

    const idleWaiters = (execution as unknown as { idleWaiters: Set<() => void> }).idleWaiters;
    expect(idleWaiters.size).toBe(0);

    await vi.advanceTimersByTimeAsync(2_000);
    await execution.stop();
  });

  it("synchronizes backlog via /messages/next before live websocket events", async () => {
    let releaseSync!: () => void;
    const syncGate = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const getNextMessage = vi.fn<() => Promise<BacklogMessage | null>>();
    const backlogMessages: BacklogMessage[] = [
      makeBacklogMessage("m-backlog", "backlog"),
      makeBacklogMessage("m-sync", "sync"),
    ];
    getNextMessage.mockImplementation(async () => {
      await syncGate;
      return backlogMessages.shift() ?? null;
    });

    const { execution, processed } = createExecution({ getNextMessage });

    await execution.enqueue(makeEvent("m-sync"));
    await execution.enqueue(makeEvent("m-live"));
    releaseSync();

    await execution.waitForIdle();
    expect(processed).toEqual(["m-backlog", "m-sync", "m-live"]);
    await execution.stop();
  });
});

describe("Execution crash recovery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recovers stale processing messages before /next sync", async () => {
    const staleMessages = [
      makeBacklogMessage("stale-1", "stale first"),
      makeBacklogMessage("stale-2", "stale second"),
    ];
    const nextMessages = [makeBacklogMessage("next-1", "from next")];

    const { execution, processed } = createExecution({
      getStaleProcessingMessages: async () => staleMessages,
      getNextMessage: vi.fn<() => Promise<BacklogMessage | null>>()
        .mockResolvedValueOnce(nextMessages[0])
        .mockResolvedValueOnce(null),
    });

    await execution.enqueue(makeEvent("ws-1"));
    await execution.waitForIdle();
    expect(processed).toEqual(["stale-1", "stale-2", "next-1", "ws-1"]);
    await execution.stop();
  });

  it("skips permanently failed messages during stale recovery", async () => {
    const context = makeContext(1);
    // Pre-mark a message as permanently failed
    context.retryTracker.markPermanentlyFailed("stale-poison");

    const staleMessages = [
      makeBacklogMessage("stale-poison", "poison"),
      makeBacklogMessage("stale-good", "good"),
    ];

    const processed: string[] = [];
    const execution = new Execution({
      roomId: "room-1",
      link: {
        getNextMessage: async () => null,
        getStaleProcessingMessages: async () => staleMessages,
        markFailed: async () => {},
      } as never,
      context: context as never,
      onExecute: async (_context, event) => {
        if (event.type === "message_created") {
          processed.push(event.payload.id);
        }
      },
    });

    await execution.waitForIdle();
    expect(processed).toEqual(["stale-good"]);
    expect(processed).not.toContain("stale-poison");
    await execution.stop();
  });

  it("skips permanently failed messages during /next sync and marks them failed on server", async () => {
    const context = makeContext(1);
    context.retryTracker.markPermanentlyFailed("next-poison");

    const markFailed = vi.fn(async () => {});

    const processed: string[] = [];
    const execution = new Execution({
      roomId: "room-1",
      link: {
        getNextMessage: vi.fn<() => Promise<BacklogMessage | null>>()
          .mockResolvedValueOnce(makeBacklogMessage("next-poison"))
          .mockResolvedValueOnce(makeBacklogMessage("next-good"))
          .mockResolvedValueOnce(null),
        getStaleProcessingMessages: async () => [],
        markFailed,
      } as never,
      context: context as never,
      onExecute: async (_context, event) => {
        if (event.type === "message_created") {
          processed.push(event.payload.id);
        }
      },
    });

    await execution.waitForIdle();
    expect(processed).toEqual(["next-good"]);
    expect(markFailed).toHaveBeenCalledWith(
      "room-1",
      "next-poison",
      "Message permanently failed after max retries",
      { bestEffort: true },
    );
    await execution.stop();
  });

  it("deduplicates messages between stale recovery and /next sync", async () => {
    const sharedId = "msg-shared";
    const staleMessages = [makeBacklogMessage(sharedId, "from stale")];

    const { execution, processed } = createExecution({
      getStaleProcessingMessages: async () => staleMessages,
      getNextMessage: vi.fn<() => Promise<BacklogMessage | null>>()
        .mockResolvedValueOnce(makeBacklogMessage(sharedId, "from next"))
        .mockResolvedValueOnce(makeBacklogMessage("next-only", "unique"))
        .mockResolvedValueOnce(null),
    });

    await execution.waitForIdle();
    // sharedId processed once (from stale), then skipped in /next, then next-only processed
    expect(processed).toEqual([sharedId, "next-only"]);
    await execution.stop();
  });

  it("sync failures do not crash the execution", async () => {
    const staleMessages = [
      makeBacklogMessage("fail-msg", "will fail"),
      makeBacklogMessage("ok-msg", "will succeed"),
    ];

    const context = makeContext(2);
    const processed: string[] = [];
    const execution = new Execution({
      roomId: "room-1",
      link: {
        getNextMessage: async () => null,
        getStaleProcessingMessages: async () => staleMessages,
        markFailed: async () => {},
      } as never,
      context: context as never,
      onExecute: async (_context, event) => {
        if (event.type === "message_created") {
          const id = event.payload.id;
          if (id === "fail-msg") {
            throw new Error("sync failure");
          }
          processed.push(id);
        }
      },
    });

    await execution.enqueue(makeEvent("ws-1"));
    await execution.waitForIdle();
    // fail-msg threw during sync but didn't crash; ok-msg and ws-1 succeeded
    expect(processed).toEqual(["ok-msg", "ws-1"]);
    await execution.stop();
  });

  it("marks message permanently failed when retries exceeded during sync", async () => {
    const markFailed = vi.fn(async () => {});
    const context = makeContext(1);
    // Record one attempt already so next attempt exceeds
    context.retryTracker.recordAttempt("retry-msg");

    const staleMessages = [makeBacklogMessage("retry-msg", "will exceed")];

    const processed: string[] = [];
    const execution = new Execution({
      roomId: "room-1",
      link: {
        getNextMessage: async () => null,
        getStaleProcessingMessages: async () => staleMessages,
        markFailed,
      } as never,
      context: context as never,
      onExecute: async (_context, event) => {
        if (event.type === "message_created") {
          processed.push(event.payload.id);
        }
      },
    });

    await execution.waitForIdle();
    expect(processed).toEqual([]);
    expect(markFailed).toHaveBeenCalledWith(
      "room-1",
      "retry-msg",
      "Message permanently failed after max retries",
      { bestEffort: true },
    );
    expect(context.retryTracker.isPermanentlyFailed("retry-msg")).toBe(true);
    await execution.stop();
  });

  it("after sync, normal WebSocket processing continues and crashes propagate", async () => {
    let wsCallCount = 0;
    const { execution, processed } = createExecution({
      onExecute: async (event) => {
        // Only fail on ws events (after sync)
        if (event.type === "message_created" && (event.payload as { id: string }).id === "ws-fail") {
          wsCallCount += 1;
          throw new Error("ws boom");
        }
      },
    });

    await execution.enqueue(makeEvent("ws-ok"));
    await execution.enqueue(makeEvent("ws-fail"));
    await expect(execution.waitUntilStopped()).rejects.toThrow("ws boom");
    expect(processed).toEqual(["ws-ok", "ws-fail"]);
    expect(wsCallCount).toBe(1);
  });

  it("gracefully handles getStaleProcessingMessages failure", async () => {
    const { execution, processed } = createExecution({
      getStaleProcessingMessages: async () => {
        throw new Error("network error");
      },
      getNextMessage: vi.fn<() => Promise<BacklogMessage | null>>()
        .mockResolvedValueOnce(makeBacklogMessage("next-1"))
        .mockResolvedValueOnce(null),
    });

    await execution.enqueue(makeEvent("ws-1"));
    await execution.waitForIdle();
    // Recovery failed gracefully, /next sync and ws events still processed
    expect(processed).toEqual(["next-1", "ws-1"]);
    await execution.stop();
  });
});

describe("Execution reconnect handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("re-runs /next synchronization after a reconnect and processes messages missed during the downtime, without ever forwarding the reconnect itself to onExecute", async () => {
    const missedMessage = makeBacklogMessage("missed-1", "missed while disconnected");
    const getNextMessage = vi
      .fn<() => Promise<BacklogMessage | null>>()
      .mockResolvedValueOnce(null) // initial /next sync at startup: nothing pending
      .mockResolvedValueOnce(missedMessage) // post-reconnect /next sync
      .mockResolvedValueOnce(null);

    const seenTypes: string[] = [];
    const { execution, processed } = createExecution({
      getNextMessage,
      onExecute: async (event) => {
        seenTypes.push(event.type);
      },
    });

    await execution.waitForIdle();
    expect(processed).toEqual([]);

    await execution.enqueue(makeReconnectedEvent());
    await execution.waitForIdle();

    expect(processed).toEqual(["missed-1"]);
    expect(seenTypes).not.toContain("reconnected");
    expect(getNextMessage).toHaveBeenCalledTimes(3);
    await execution.stop();
  });

  it("treats a live WebSocket message enqueued right after a reconnect as the sync boundary for the re-run /next synchronization", async () => {
    const getNextMessage = vi
      .fn<() => Promise<BacklogMessage | null>>()
      .mockResolvedValueOnce(null) // initial /next sync at startup
      .mockResolvedValueOnce(makeBacklogMessage("m-before", "missed while disconnected"))
      .mockResolvedValueOnce(makeBacklogMessage("m-live", "same id as the live message queued after reconnect"));

    const { execution, processed } = createExecution({ getNextMessage });

    await execution.waitForIdle();

    await execution.enqueue(makeReconnectedEvent());
    await execution.enqueue(makeEvent("m-live"));

    await execution.waitForIdle();

    // /next drains "m-before", then the sync-boundary message "m-live" once —
    // the live WebSocket delivery of that same id is recognized as the
    // already-processed duplicate and skipped, not processed twice.
    expect(processed).toEqual(["m-before", "m-live"]);
    expect(getNextMessage).toHaveBeenCalledTimes(3);
    await execution.stop();
  });

  it("gives overlapping queued reconnects separate live-message synchronization boundaries", async () => {
    const getNextMessage = vi
      .fn<() => Promise<BacklogMessage | null>>()
      .mockResolvedValueOnce(null) // startup sync
      .mockResolvedValueOnce(makeBacklogMessage("live-a", "first reconnect boundary"))
      .mockResolvedValueOnce(makeBacklogMessage("live-b", "second reconnect boundary"));

    const { execution, processed } = createExecution({ getNextMessage });

    await execution.waitForIdle();

    await execution.enqueue(makeReconnectedEvent());
    await execution.enqueue(makeEvent("live-a"));
    await execution.enqueue(makeReconnectedEvent());
    await execution.enqueue(makeEvent("live-b"));
    await execution.waitForIdle();

    expect(processed).toEqual(["live-a", "live-b"]);
    expect(getNextMessage).toHaveBeenCalledTimes(3);
    await execution.stop();
  });

  it("executes a message exactly once when a second reconnect is queued before the first boundary's own live message arrives", async () => {
    let resolveFirstReconnectSync!: (message: BacklogMessage | null) => void;
    const firstReconnectSyncPending = new Promise<BacklogMessage | null>((resolve) => {
      resolveFirstReconnectSync = resolve;
    });
    const getNextMessage = vi
      .fn<() => Promise<BacklogMessage | null>>()
      .mockResolvedValueOnce(null) // startup sync
      .mockImplementationOnce(() => firstReconnectSyncPending) // first reconnect's sync: held open
      .mockResolvedValueOnce(null); // second reconnect's own sync

    const { execution, processed } = createExecution({ getNextMessage });

    await execution.waitForIdle();

    await execution.enqueue(makeReconnectedEvent()); // R1: its sync is now blocked on getNextMessage
    await execution.enqueue(makeReconnectedEvent()); // R2, queued before R1's own live message arrives
    await execution.enqueue(makeEvent("m1")); // live delivery of the same message R1's backlog scan will find

    // R1's blocked backlog scan now discovers "m1" — the same id its live
    // delivery above already queued.
    resolveFirstReconnectSync(makeBacklogMessage("m1", "arrived during the outage"));
    await execution.waitForIdle();

    // "m1" is recovered exactly once via R1's backlog sync; its live
    // delivery is recognized as the already-synced duplicate and skipped,
    // even though R2 was queued (and reassigned the newest boundary) before
    // that live delivery ever arrived.
    expect(processed).toEqual(["m1"]);
    expect(getNextMessage).toHaveBeenCalledTimes(3);
    await execution.stop();
  });
});
