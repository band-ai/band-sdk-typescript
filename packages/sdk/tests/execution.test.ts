import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { SYNTHETIC_CONTACT_EVENTS_SENDER_ID, SYNTHETIC_SENDER_TYPE } from "../src/contracts/protocols";
import { RecoverableTurnError, RuntimeStateError } from "../src/core/errors";
import type { PlatformEvent } from "../src/platform/events";
import { Execution } from "../src/runtime/Execution";
import { makeLoggerSpy } from "./testUtils";
import type { ExecutionState } from "../src/runtime/ExecutionContext";
import { RetryTracker } from "@band-ai/band-sdk-core";
import { createDeferred } from "../src/core/deferred";

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

function makeEvent(id: string, sender = { id: "user-1", type: "User" }): PlatformEvent {
  return {
    type: "message_created",
    roomId: "room-1",
    payload: {
      id,
      content: "hello",
      message_type: "text",
      sender_id: sender.id,
      sender_type: sender.type,
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

/**
 * The platform's backlog as Band documents it: /next returns the oldest
 * message not yet processed — a failed one stays the head — and a terminal
 * mark is recorded only against an open processing attempt. "To give up on a
 * message, claim it and mark it `processed`"
 * (docs.band.ai/integrations/custom-integration).
 */
class FakeBacklog {
  public readonly processed = new Set<string>();
  public polls = 0;
  private readonly attempts = new Set<string>();

  public constructor(private readonly messages: BacklogMessage[]) {}

  /** Posts a message live: Band serves it on /next too until it is processed. */
  public post(id: string): PlatformEvent {
    this.messages.push(makeBacklogMessage(id));
    return makeEvent(id);
  }

  /** A room on this backlog whose turns leave marking to `PlatformRuntime`, which these tests leave out. */
  public room(options: { stale?: BacklogMessage[] } = {}) {
    const processed: string[] = [];
    const execution = new Execution({
      roomId: "room-1",
      link: { ...this.link(), getStaleProcessingMessages: async () => options.stale ?? [] } as never,
      context: makeContext() as never,
      onExecute: async (_context, event) => {
        if (event.type === "message_created") {
          processed.push(event.payload.id);
        }
      },
    });
    return { execution, processed };
  }

  public link(overrides: { markProcessed?: () => Promise<void> } = {}) {
    return {
      getNextMessage: async () => {
        this.polls += 1;
        return this.messages.find((message) => !this.processed.has(message.id)) ?? null;
      },
      getStaleProcessingMessages: async () => [],
      markProcessing: async (_roomId: string, messageId: string) => {
        this.attempts.add(messageId);
      },
      markProcessed:
        overrides.markProcessed
        ?? (async (_roomId: string, messageId: string) => {
          if (!this.attempts.delete(messageId)) {
            throw new Error("422: no active processing attempt");
          }
          this.processed.add(messageId);
        }),
    };
  }
}

function makeContext(maxRetries = 1) {
  const states: ExecutionState[] = [];
  const retryTracker = new RetryTracker(maxRetries);
  return {
    setState(state: ExecutionState) {
      states.push(state);
    },
    closeWorkingState: async () => undefined,
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
  it("does not let a retired execution's held completion release its replacement room", async () => {
    const oldEnd = createDeferred<void>();
    const newEnd = createDeferred<void>();
    const control = createDeferred<void>();
    const processed: string[] = [];
    const held = (end: Promise<void>, record: boolean) => new Execution({
      roomId: "room-1",
      link: { getNextMessage: async () => null, getStaleProcessingMessages: async () => [] } as never,
      context: makeContext() as never,
      isControlEvent: (event) => event.type === "message_created" && event.payload.id === "control",
      onExecute: async (_context, event, _admitted, hold) => {
        if (event.type !== "message_created") return;
        if (event.payload.id === "first") hold(end);
        if (record) processed.push(event.payload.id);
        if (event.payload.id === "control") control.resolve();
      },
    });
    const old = held(oldEnd.promise, false);
    let replacement: Execution | undefined;
    try {
      await old.enqueue(makeEvent("first"));
      await old.waitForIdle();
      await old.stop(0);
      replacement = held(newEnd.promise, true);
      await replacement.enqueue(makeEvent("first"));
      await replacement.waitForIdle();
      await replacement.enqueue(makeEvent("second"));
      oldEnd.resolve();
      await oldEnd.promise;
      await replacement.enqueue(makeEvent("control"));
      await control.promise;
      expect(processed).toEqual(["first", "control"]);
      expect(old.state.status).toBe("stopped");
      newEnd.resolve();
      await newEnd.promise;
      await replacement.waitForIdle();
      expect(processed).toEqual(["first", "control", "second"]);
    } finally {
      oldEnd.resolve();
      newEnd.resolve();
      await old.stop(0);
      await replacement?.stop(0);
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not start a turn from a backlog read that returns after a forced stop", async () => {
    const reading = createDeferred();
    const response = createDeferred<BacklogMessage | null>();
    const { execution, processed } = createExecution({
      getNextMessage: async () => {
        reading.resolve();
        return await response.promise;
      },
    });
    await reading.promise;

    await execution.stop(0);
    response.resolve(makeBacklogMessage("waiting"));
    await execution.waitForIdle();

    expect(processed).toEqual([]);
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

  it("gives up on a permanently failed /next head by marking it processed, then reaches the message behind it", async () => {
    const context = makeContext(1);
    context.retryTracker.markPermanentlyFailed("next-poison");
    const backlog = new FakeBacklog([makeBacklogMessage("next-poison"), makeBacklogMessage("next-good")]);
    const processed: string[] = [];
    const execution = new Execution({
      roomId: "room-1",
      link: backlog.link() as never,
      context: context as never,
      onExecute: async (_context, event) => {
        if (event.type === "message_created") {
          processed.push(event.payload.id);
        }
      },
    });

    await execution.waitForIdle();
    // Band keeps a failed message at the head of /next; only a processed mark moves past it.
    expect(backlog.processed.has("next-poison")).toBe(true);
    expect(processed).toEqual(["next-good"]);
    await execution.stop();
  });

  it("stops polling, rather than spinning, when the platform refuses the give-up mark", async () => {
    const context = makeContext(1);
    context.retryTracker.markPermanentlyFailed("next-poison");
    const backlog = new FakeBacklog([makeBacklogMessage("next-poison")]);
    const execution = new Execution({
      roomId: "room-1",
      link: backlog.link({ markProcessed: async () => { throw new Error("503"); } }) as never,
      context: context as never,
      onExecute: async () => {},
    });

    await execution.waitForIdle();
    // Seen once to give up on, once more still heading /next: then the scan ends.
    expect(backlog.polls).toBe(2);
    await execution.stop();
  });

  it("gives up on a stale-recovered message /next still serves, instead of running it again", async () => {
    const shared = makeBacklogMessage("msg-shared");
    const backlog = new FakeBacklog([shared, makeBacklogMessage("next-only")]);
    const { execution, processed } = backlog.room({ stale: [shared] });

    await execution.waitForIdle();
    expect(processed).toEqual(["msg-shared", "next-only"]);
    expect(backlog.processed.has("msg-shared")).toBe(true);
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

  it("logs a turn's own failure as one warning with its name and cause, not an error, on the sync path too", async () => {
    const logger = makeLoggerSpy();
    const execution = new Execution({
      roomId: "room-1",
      link: {
        getNextMessage: async () => null,
        getStaleProcessingMessages: async () => [makeBacklogMessage("silent")],
        markFailed: async () => {},
      } as never,
      context: makeContext(2) as never,
      logger,
      onExecute: async () => {
        throw new RecoverableTurnError("could not post the reply", new Error("HTTP 503"));
      },
    });

    await execution.enqueue(makeEvent("ws-1"));
    await execution.waitForIdle();
    await execution.stop();

    const turnFailed = { roomId: "room-1", error: "could not post the reply", name: "RecoverableTurnError", cause: new Error("HTTP 503") };
    expect(logger.warn).toHaveBeenCalledWith("Turn failed without stopping the room", { ...turnFailed, messageId: "silent" });
    expect(logger.warn).toHaveBeenCalledWith("Turn failed without stopping the room", { ...turnFailed, eventType: "message_created" });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("gives up on a message whose retries are exhausted during sync by marking it processed", async () => {
    const context = makeContext(1);
    // Record one attempt already so next attempt exceeds
    context.retryTracker.recordAttempt("retry-msg");

    const staleMessages = [makeBacklogMessage("retry-msg", "will exceed")];
    const backlog = new FakeBacklog([]);

    const processed: string[] = [];
    const execution = new Execution({
      roomId: "room-1",
      link: { ...backlog.link(), getStaleProcessingMessages: async () => staleMessages } as never,
      context: context as never,
      onExecute: async (_context, event) => {
        if (event.type === "message_created") {
          processed.push(event.payload.id);
        }
      },
    });

    await execution.waitForIdle();
    expect(processed).toEqual([]);
    expect(backlog.processed.has("retry-msg")).toBe(true);
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

  it("executes a message exactly once when the backlog scan discovers it before its own live delivery anchors the boundary", async () => {
    let resolveReconnectSync!: (message: BacklogMessage | null) => void;
    const reconnectSyncPending = new Promise<BacklogMessage | null>((resolve) => {
      resolveReconnectSync = resolve;
    });
    const getNextMessage = vi
      .fn<() => Promise<BacklogMessage | null>>()
      .mockResolvedValueOnce(null) // startup sync
      .mockImplementationOnce(() => reconnectSyncPending) // reconnect's first /next call: held open
      .mockResolvedValueOnce(null); // reconnect's second /next call: backlog exhausted

    const { execution, processed } = createExecution({ getNextMessage });

    await execution.waitForIdle();

    await execution.enqueue(makeReconnectedEvent()); // R1: its sync is now blocked on getNextMessage

    // The backlog scan discovers "m1" while the boundary is still unanchored
    // — its live delivery hasn't reached enqueue() yet — and the scan then
    // exhausts (returns null) without ever recognizing "m1" as its own sync
    // point.
    resolveReconnectSync(makeBacklogMessage("m1", "discovered by backlog scan first"));
    await execution.waitForIdle();

    // Only now does the live delivery of the same message arrive.
    await execution.enqueue(makeEvent("m1"));
    // waitForIdle() alone can race ahead of executeEvent() actually running
    // (enqueue() can hand a queued event straight to a parked waiter before
    // `inFlight` is incremented) — stop() waits for the process loop itself
    // to fully drain, which is what this assertion needs.
    await execution.stop();

    expect(processed).toEqual(["m1"]);
    // Startup sync + the reconnect's two /next calls (backlog "m1", then
    // null) — confirms the live delivery was recognized as a duplicate
    // rather than triggering a further backlog scan of its own.
    expect(getNextMessage).toHaveBeenCalledTimes(3);
  });

  it("gives up on a message a reconnect's scan ran but /next still serves, instead of running it again", async () => {
    const backlog = new FakeBacklog([]);
    const { execution, processed } = backlog.room();
    await execution.waitForIdle();

    backlog.post("m1");
    await execution.enqueue(makeReconnectedEvent());
    await execution.enqueue(makeReconnectedEvent());
    await execution.stop();

    expect(processed).toEqual(["m1"]);
    expect(backlog.processed.has("m1")).toBe(true);
    // Startup; the first scan's run, re-sighting and empty read; the second scan's empty read.
    expect(backlog.polls).toBe(5);
  });

  it("skips the live delivery of a message a reconnect's scan already ran", async () => {
    const backlog = new FakeBacklog([]);
    const { execution, processed } = backlog.room();
    await execution.waitForIdle();

    const live = backlog.post("m1");
    await execution.enqueue(makeReconnectedEvent());
    await execution.waitForIdle();
    await execution.enqueue(live);
    await execution.enqueue(makeReconnectedEvent());
    await execution.stop();

    expect(processed).toEqual(["m1"]);
  });
});

describe("Execution bootstrap messages", () => {
  it("tells a queued bootstrap it will not run when the room fails before reaching it", async () => {
    const running = createDeferred();
    const release = createDeferred();
    let reads = 0;
    const execution = new Execution({
      roomId: "room-1",
      link: {
        getStaleProcessingMessages: async () => [],
        getNextMessage: async () => {
          reads += 1;
          if (reads > 1) throw new Error("503 on /messages/next");
          return null;
        },
      } as never,
      context: makeContext() as never,
      onExecute: async (_context, event) => {
        if (event.type === "message_created" && event.payload.id === "live") {
          running.resolve();
          await release.promise;
        }
      },
    });
    await execution.waitForIdle();
    await execution.enqueue(makeEvent("live"));
    await running.promise;
    await execution.enqueue(makeReconnectedEvent());
    const bootstrapping = execution.bootstrapMessage(makeBacklogMessage("boot") as never);
    release.resolve();

    await expect(bootstrapping).rejects.toThrow(RuntimeStateError);
    await expect(execution.stop()).rejects.toThrow("503 on /messages/next");
  });

  it("lets a stop that waits for the room finish once the bootstrap turn ends", async () => {
    const running = createDeferred();
    const release = createDeferred();
    const { execution } = createExecution({
      onExecute: async () => {
        running.resolve();
        await release.promise;
      },
    });
    await execution.waitForIdle();
    const bootstrapping = execution.bootstrapMessage(makeBacklogMessage("boot") as never);
    await running.promise;
    const stopping = execution.stop();
    release.resolve();

    await bootstrapping;
    await expect(stopping).resolves.toBe(true);
  });

  it("keeps a synthetic turn queued while the room is paused, since Band cannot serve it again, and runs it on resume", async () => {
    const ran = createDeferred<void>();
    const { execution, processed } = createExecution({ onExecute: async () => ran.resolve() });
    onTestFinished(() => execution.stop(0).then(() => undefined));
    execution.pause("host");

    await execution.enqueue(makeEvent("live"));
    await execution.enqueue(makeEvent("synthetic", { id: SYNTHETIC_CONTACT_EVENTS_SENDER_ID, type: SYNTHETIC_SENDER_TYPE }));
    await execution.waitForIdle();
    expect(processed).toEqual([]);

    execution.resume("host");
    await ran.promise;
    expect(processed).toEqual(["synthetic"]);
  });

  it("runs a room only once every pause source has lifted its pause, and catches up then", async () => {
    let reads = 0;
    const caughtUp = createDeferred<void>();
    const { execution } = createExecution({
      getNextMessage: async () => {
        reads += 1;
        if (reads > 1) caughtUp.resolve();
        return null;
      },
    });
    onTestFinished(() => execution.stop(0).then(() => undefined));
    await execution.waitForIdle();
    const startupReads = reads;

    expect(execution.pause("host")).toBe(true);
    expect(execution.pause("band")).toBe(true);
    expect(execution.pause("band")).toBe(false);
    expect(execution.resume("band")).toBe(true);
    await execution.waitForIdle();
    expect(execution.isPaused()).toBe(true);
    expect(reads).toBe(startupReads);

    expect(execution.resume("host")).toBe(true);
    await caughtUp.promise;
    expect(execution.isPaused()).toBe(false);
  });
});

