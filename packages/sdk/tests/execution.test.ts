import { afterEach, describe, expect, it, vi } from "vitest";

import type { PlatformEvent } from "../src/platform/events";
import { Execution } from "../src/runtime/Execution";
import type { ExecutionState } from "../src/runtime/ExecutionContext";
import { MessageRetryTracker } from "../src/runtime/retryTracker";

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
  const retryTracker = new MessageRetryTracker(maxRetries);
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
        .mockResolvedValueOnce(nextMessages[0] ?? null)
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
