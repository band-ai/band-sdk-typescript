import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Agent } from "../src/agent/Agent";
import { RuntimeStateError } from "../src/core/errors";
import { BandLink } from "../src/platform/BandLink";
import type { PlatformEvent } from "../src/platform/events";
import type { StreamingTransport, TopicHandlers } from "../src/platform/streaming/transport";
import { Execution } from "../src/runtime/Execution";
import type { ExecutionState } from "../src/runtime/ExecutionContext";
import { PlatformRuntime, type PlatformRuntimeOptions } from "../src/runtime/PlatformRuntime";
import { AgentRuntime } from "../src/runtime/rooms/AgentRuntime";
import { MessageRetryTracker } from "../src/runtime/retryTracker";
import {
  isLegalExecutionTransition,
  isLegalRuntimeTransition,
  type ExecutionLifecycleStatus,
  type RuntimeLifecycleStatus,
} from "../src/runtime/lifecycle";
// The lifecycle union must be one declaration, reachable from both public entry points.
import type { RuntimeLifecycleState as RootLifecycleState } from "../src/index";
import type { RuntimeLifecycleState as RuntimeSubpathLifecycleState } from "../src/runtime/index";
import { FakeRestApi } from "./testUtils";

const AGENT_ID = "a1";
const API_KEY = "k";
/** The room used by the single-room fixtures; must match the emitted topics. */
const ROOM_ID = "room-1";

/**
 * Long enough that a promise which was going to settle on its own already has,
 * so one still pending after this window is genuinely parked.
 */
const SETTLE_WINDOW_MS = 20;

/** Shorter than any gated handler here, so a stop bounded by it must time out. */
const FORCED_STOP_TIMEOUT_MS = 10;

/** Yields one macrotask so an in-flight start()/stop() can reach its first await. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function settleWindow(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SETTLE_WINDOW_MS));
}

interface Gate {
  /** Blocks the gated operation until `release()` is called. */
  wait: () => Promise<void>;
  release: () => void;
}

/** A promise a test can hold an operation on and open at a chosen moment. */
function createGate(): Gate {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { wait: () => opened, release };
}

/**
 * Resolves with the rejection reason, or `null` if the promise fulfilled. The
 * handler is attached synchronously, so parking on the result never lets the
 * rejection surface as an unhandled one first.
 */
function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

class FakeTransport implements StreamingTransport {
  public connectCount = 0;
  public disconnectCount = 0;
  /** Optional gate so a test can hold a connect open mid-start. */
  public beforeConnect?: () => Promise<void>;
  private readonly handlers = new Map<string, TopicHandlers>();
  private connected = false;

  public async connect() {
    await this.beforeConnect?.();
    this.connectCount += 1;
    this.connected = true;
  }

  public async disconnect() {
    this.disconnectCount += 1;
    this.connected = false;
  }

  public async join(topic: string, handlers: TopicHandlers) {
    this.handlers.set(topic, handlers);
  }

  public async leave(topic: string) {
    this.handlers.delete(topic);
  }

  public async runForever(signal?: AbortSignal): Promise<void> {
    if (!signal) {
      return;
    }
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  }

  public isConnected() {
    return this.connected;
  }

  public async emit(topic: string, event: string, payload: Record<string, unknown>): Promise<void> {
    const topicHandlers = this.handlers.get(topic);
    if (!topicHandlers?.[event]) {
      throw new Error(`No handler for ${topic}/${event}`);
    }

    await Promise.resolve(topicHandlers[event](payload));
  }
}

interface StubAdapter {
  onEvent: ReturnType<typeof vi.fn>;
  onStarted: ReturnType<typeof vi.fn>;
  onCleanup: ReturnType<typeof vi.fn>;
  onRuntimeStop: ReturnType<typeof vi.fn>;
}

function makeAdapter(onRuntimeStop?: () => Promise<void>): StubAdapter {
  return {
    onEvent: vi.fn(async () => undefined),
    onStarted: vi.fn(async () => undefined),
    onCleanup: vi.fn(async () => undefined),
    onRuntimeStop: vi.fn(onRuntimeStop ?? (async () => undefined)),
  };
}

function makeLink(transport: StreamingTransport): BandLink {
  return new BandLink({
    agentId: AGENT_ID,
    apiKey: API_KEY,
    transport,
    restApi: new FakeRestApi(),
  });
}

/** AgentRuntime's option interface is not exported, so derive it from the constructor. */
type AgentRuntimeOptions = ConstructorParameters<typeof AgentRuntime>[0];

function makePlatformRuntime(
  transport: StreamingTransport,
  overrides: Partial<PlatformRuntimeOptions> = {},
): PlatformRuntime {
  return new PlatformRuntime({
    agentId: AGENT_ID,
    apiKey: API_KEY,
    link: makeLink(transport),
    ...overrides,
  });
}

function makeAgentRuntime(
  transport: StreamingTransport,
  overrides: Partial<AgentRuntimeOptions> = {},
): AgentRuntime {
  return new AgentRuntime({
    link: makeLink(transport),
    agentId: AGENT_ID,
    onExecute: async () => undefined,
    ...overrides,
  });
}

async function emitRoomAdded(transport: FakeTransport, roomId: string): Promise<void> {
  await transport.emit(`agent_rooms:${AGENT_ID}`, "room_added", {
    id: roomId,
    status: "active",
    type: "direct",
    title: "Room",
    removed_at: "",
  });
}

async function emitMessage(
  transport: FakeTransport,
  roomId: string,
  id: string,
  content: string,
): Promise<void> {
  const now = new Date().toISOString();
  await transport.emit(`chat_room:${roomId}`, "message_created", {
    id,
    content,
    message_type: "text",
    sender_id: "u1",
    sender_type: "User",
    sender_name: "Jane",
    inserted_at: now,
    updated_at: now,
  });
}

function makeExecutionEvent(id: string, roomId = ROOM_ID): PlatformEvent {
  const now = new Date("2026-03-05T00:00:00.000Z").toISOString();
  return {
    type: "message_created",
    roomId,
    payload: {
      id,
      content: "hello",
      message_type: "text",
      sender_id: "user-1",
      sender_type: "User",
      sender_name: "User One",
      metadata: {},
      inserted_at: now,
      updated_at: now,
    },
  };
}

function makeExecution(onExecute: () => Promise<void> = async () => undefined): Execution {
  const retryTracker = new MessageRetryTracker(1);
  const context = {
    setState: (_state: ExecutionState) => undefined,
    getRetryTracker: () => retryTracker,
  };

  return new Execution({
    roomId: ROOM_ID,
    link: {
      getNextMessage: async () => null,
      getStaleProcessingMessages: async () => [],
      markFailed: async () => {},
    } as never,
    context: context as never,
    onExecute,
  });
}

/** Fails the assertion if the wrapped work produces a process-level unhandled rejection. */
async function withoutUnhandledRejections(work: () => Promise<void>): Promise<void> {
  const seen: unknown[] = [];
  const listener = (error: unknown): void => {
    seen.push(error);
  };
  process.on("unhandledRejection", listener);
  try {
    await work();
    // Unhandled rejections are reported once the microtask queue has drained and
    // the promise has been garbage-collection-eligible for a turn of the loop.
    await settleWindow();
  } finally {
    process.off("unhandledRejection", listener);
  }

  expect(seen).toEqual([]);
}

describe("lifecycle state machine", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Adding a status without a case in the transition switch fails `tsc`, because
  // the switch's default branch narrows to `never`. These maps are the
  // compile-time half of that proof: they stop compiling if a status is added.
  const RUNTIME_STATUSES: Record<RuntimeLifecycleStatus, true> = {
    not_started: true,
    starting: true,
    running: true,
    stopping: true,
    stopped: true,
    failed: true,
  };
  const EXECUTION_STATUSES: Record<ExecutionLifecycleStatus, true> = {
    running: true,
    stopping: true,
    stopped: true,
    failed: true,
  };

  it("every declared status is handled by its transition table", () => {
    const runtimeStatuses = Object.keys(RUNTIME_STATUSES) as RuntimeLifecycleStatus[];
    for (const from of runtimeStatuses) {
      for (const to of runtimeStatuses) {
        expect(typeof isLegalRuntimeTransition(from, to)).toBe("boolean");
      }
    }

    const executionStatuses = Object.keys(EXECUTION_STATUSES) as ExecutionLifecycleStatus[];
    for (const from of executionStatuses) {
      for (const to of executionStatuses) {
        expect(typeof isLegalExecutionTransition(from, to)).toBe("boolean");
      }
    }

    // The two blockers exist because a terminal state used to disable future work.
    expect(isLegalRuntimeTransition("stopped", "starting")).toBe(true);
    expect(isLegalRuntimeTransition("failed", "starting")).toBe(true);
    expect(isLegalExecutionTransition("stopped", "running")).toBe(false);
  });

  it("the replaced lifecycle booleans no longer exist on the four classes", async () => {
    const transport = new FakeTransport();
    const platformRuntime = makePlatformRuntime(transport);
    const agent = new Agent(platformRuntime, makeAdapter() as never);
    const agentRuntime = makeAgentRuntime(transport);
    const execution = makeExecution();

    for (const field of ["started", "startPromise"]) {
      expect(Object.prototype.hasOwnProperty.call(agent, field), field).toBe(false);
    }
    expect(Object.prototype.hasOwnProperty.call(platformRuntime, "stopping")).toBe(false);
    for (const field of ["running", "stopping"]) {
      expect(Object.prototype.hasOwnProperty.call(agentRuntime, field), field).toBe(false);
    }
    expect(Object.prototype.hasOwnProperty.call(execution, "running")).toBe(false);

    await execution.stop();
  });

  it("all four classes expose a public state getter with a `status` discriminant", async () => {
    const transport = new FakeTransport();
    const platformRuntime = makePlatformRuntime(transport);
    const agent = new Agent(platformRuntime, makeAdapter() as never);
    const agentRuntime = makeAgentRuntime(transport);
    const execution = makeExecution();

    expect(agent.state).toEqual({ status: "not_started" });
    expect(platformRuntime.state).toEqual({ status: "not_started" });
    expect(agentRuntime.state).toEqual({ status: "not_started" });
    expect(execution.state).toEqual({ status: "running" });

    await execution.stop();
  });

  it("the lifecycle union is the same declaration on both public entry points", () => {
    const fromRoot: RootLifecycleState = { status: "running" };
    const fromSubpath: RuntimeSubpathLifecycleState = fromRoot;
    const backToRoot: RootLifecycleState = fromSubpath;

    expect(backToRoot.status).toBe("running");
  });

  it("Execution and ExecutionContext state vocabularies are disjoint and cross-referenced", () => {
    const lifecycleNames = Object.keys(EXECUTION_STATUSES);
    const perTurnNames: ExecutionState[] = ["starting", "idle", "processing"];
    expect(lifecycleNames.filter((name) => perTurnNames.includes(name as ExecutionState))).toEqual([]);

    const srcDir = join(__dirname, "../src/runtime");
    expect(readFileSync(join(srcDir, "Execution.ts"), "utf8")).toContain("@see ExecutionContext.state");
    expect(readFileSync(join(srcDir, "ExecutionContext.ts"), "utf8")).toContain("@see Execution.state");
  });

  it("the value returned by state is immutable from the caller's perspective", async () => {
    const execution = makeExecution();
    const observed = execution.state;
    expect(Object.isFrozen(observed)).toBe(true);

    try {
      (observed as { status: string }).status = "stopped";
    } catch {
      // Frozen objects throw on assignment in strict mode; either way the
      // instance's own lifecycle must be untouched.
    }

    expect(execution.state.status).toBe("running");
    await execution.stop();
  });
});

describe("PlatformRuntime lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a failed stop does not disable teardown on the next start/stop cycle", async () => {
    const transport = new FakeTransport();
    const runtime = makePlatformRuntime(transport);
    let failCleanup = true;
    const adapter = makeAdapter(async () => {
      if (failCleanup) {
        failCleanup = false;
        throw new Error("adapter cleanup failed");
      }
    });
    const runtimeStop = vi.spyOn(AgentRuntime.prototype, "stop");

    await runtime.start(adapter as never);
    await expect(runtime.stop()).rejects.toThrow("adapter cleanup failed");
    expect(runtime.state.status).toBe("failed");

    await runtime.start(adapter as never);
    expect(runtime.state).toEqual({ status: "running" });

    const stopsBefore = runtimeStop.mock.calls.length;
    const cleanupsBefore = adapter.onRuntimeStop.mock.calls.length;
    const disconnectsBefore = transport.disconnectCount;

    await expect(runtime.stop()).resolves.toBe(true);

    expect(runtimeStop.mock.calls.length - stopsBefore).toBe(1);
    expect(adapter.onRuntimeStop.mock.calls.length - cleanupsBefore).toBe(1);
    expect(transport.disconnectCount - disconnectsBefore).toBe(1);
    expect(runtime.state).toEqual({ status: "stopped" });
  });

  it("a failed start whose cleanup also failed does not poison the instance", async () => {
    const transport = new FakeTransport();
    const runtime = makePlatformRuntime(transport);
    let failCleanup = true;
    const adapter = makeAdapter(async () => {
      if (failCleanup) {
        failCleanup = false;
        throw new Error("adapter cleanup failed");
      }
    });

    const runtimeStart = vi.spyOn(AgentRuntime.prototype, "start")
      .mockRejectedValueOnce(new Error("runtime start failed"));

    await expect(runtime.start(adapter as never)).rejects.toBeInstanceOf(AggregateError);
    expect(runtime.state.status).toBe("failed");

    runtimeStart.mockRestore();
    await runtime.start(adapter as never);

    const cleanupsBefore = adapter.onRuntimeStop.mock.calls.length;
    const disconnectsBefore = transport.disconnectCount;
    await expect(runtime.stop()).resolves.toBe(true);

    expect(adapter.onRuntimeStop.mock.calls.length - cleanupsBefore).toBe(1);
    expect(transport.disconnectCount - disconnectsBefore).toBe(1);
  });

  it("a concurrent stop awaits the in-flight teardown instead of reporting success", async () => {
    const transport = new FakeTransport();
    const runtime = makePlatformRuntime(transport);
    const cleanupGate = createGate();
    const adapter = makeAdapter(async () => {
      await cleanupGate.wait();
    });

    await runtime.start(adapter as never);

    const settled: string[] = [];
    const first = runtime.stop().then((value) => {
      settled.push("first");
      return value;
    });
    const second = runtime.stop().then((value) => {
      settled.push("second");
      return value;
    });

    await settleWindow();
    expect(settled).toEqual([]);

    cleanupGate.release();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(settled).toEqual(["first", "second"]);
    expect(adapter.onRuntimeStop).toHaveBeenCalledTimes(1);
  });

  it("coalesced stop callers receive the identical Error instance", async () => {
    const transport = new FakeTransport();
    const runtime = makePlatformRuntime(transport);
    const failure = new Error("adapter cleanup failed");
    const adapter = makeAdapter(async () => {
      throw failure;
    });

    await runtime.start(adapter as never);

    // Both stops are in flight before either settles, so the second coalesces.
    const first = rejectionOf(runtime.stop());
    const second = rejectionOf(runtime.stop());

    const firstError = await first;
    const secondError = await second;

    expect(firstError).toBe(failure);
    expect(secondError).toBe(firstError);
  });

  it("start() while a stop is in flight rejects with RuntimeStateError", async () => {
    const transport = new FakeTransport();
    const runtime = makePlatformRuntime(transport);
    const cleanupGate = createGate();
    const adapter = makeAdapter(async () => {
      await cleanupGate.wait();
    });

    await runtime.start(adapter as never);
    const stopPromise = runtime.stop();
    expect(runtime.state).toEqual({ status: "stopping" });

    await expect(runtime.start(adapter as never)).rejects.toBeInstanceOf(RuntimeStateError);

    cleanupGate.release();
    await expect(stopPromise).resolves.toBe(true);
  });

  it("an external stop coalesces with the internal cleanup stop of a failing start", async () => {
    const transport = new FakeTransport();
    const runtime = makePlatformRuntime(transport);
    const adapter = makeAdapter();

    const startGate = createGate();
    vi.spyOn(AgentRuntime.prototype, "start").mockImplementation(async () => {
      await startGate.wait();
      throw new Error("runtime start failed");
    });

    const startPromise = runtime.start(adapter as never);
    await yieldToEventLoop();

    // External caller races the cleanup stop() that start()'s own failure path runs.
    const externalStop = runtime.stop();
    startGate.release();

    await expect(startPromise).rejects.toThrow("runtime start failed");
    await expect(externalStop).resolves.toBe(true);
    expect(adapter.onRuntimeStop).toHaveBeenCalledTimes(1);
  });

  it("a post-stop enqueue on the contact hub path is handled, not left unhandled", async () => {
    const transport = new FakeTransport();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const runtime = makePlatformRuntime(transport, {
      logger,
      contactConfig: { strategy: "hub_room", hubTaskId: "task-1" },
    });
    const adapter = makeAdapter();

    vi.spyOn(AgentRuntime.prototype, "enqueueEvent").mockRejectedValue(
      new RuntimeStateError("Execution for room hub has already ended (status: stopped); enqueue() is a no-op after stop()"),
    );

    await withoutUnhandledRejections(async () => {
      await runtime.start(adapter as never);
      await transport.emit(`agent_contacts:${AGENT_ID}`, "contact_request_received", {
        id: "req-1",
        from_handle: "alice",
        from_name: "Alice",
        message: "Hello!",
        status: "pending",
        inserted_at: new Date().toISOString(),
      });
      await settleWindow();
    });

    const reported = logger.error.mock.calls.find(
      ([message]) => message === "Dropped contact hub event for a stopped room execution",
    );
    expect(reported).toBeDefined();

    await runtime.stop();
  });

  it("stop() during the early window of a start does not report a teardown it did not perform", async () => {
    const transport = new FakeTransport();
    const runtime = makePlatformRuntime(transport);
    const startedGate = createGate();
    const adapter = makeAdapter();
    adapter.onStarted.mockImplementation(async () => {
      await startedGate.wait();
    });

    // Held before `activeAdapter`/`runtime` are assigned: the window in which
    // stop() used to short-circuit to "stopped" while start() built a live runtime.
    const startPromise = runtime.start(adapter as never);
    await yieldToEventLoop();
    expect(runtime.state).toEqual({ status: "starting" });

    const settled: string[] = [];
    const stopPromise = runtime.stop().then((value) => {
      settled.push("stop");
      return value;
    });

    await settleWindow();
    expect(settled).toEqual([]);
    expect(runtime.state).toEqual({ status: "starting" });

    startedGate.release();
    await startPromise;
    await expect(stopPromise).resolves.toBe(true);

    // The reported "stopped" is backed by a teardown that actually happened.
    expect(runtime.state).toEqual({ status: "stopped" });
    expect(adapter.onRuntimeStop).toHaveBeenCalledTimes(1);
    expect(transport.isConnected()).toBe(false);
  });

  it("stop() during the early window of a failing start reports the failure, now and on every later call", async () => {
    const transport = new FakeTransport();
    const runtime = makePlatformRuntime(transport);
    const failure = new Error("adapter onStarted failed");
    const startedGate = createGate();
    const adapter = makeAdapter();
    adapter.onStarted.mockImplementation(async () => {
      await startedGate.wait();
      throw failure;
    });

    // Fails before `activeAdapter`/`runtime` are assigned, so there is nothing to
    // tear down — but the parked stop() must not read that as a graceful shutdown.
    const startPromise = runtime.start(adapter as never);
    await yieldToEventLoop();
    expect(runtime.state).toEqual({ status: "starting" });

    const startOutcome = rejectionOf(startPromise);
    const stopOutcome = rejectionOf(runtime.stop());
    startedGate.release();

    expect(await startOutcome).toBe(failure);
    expect(await stopOutcome).toBe(failure);
    expect(runtime.state).toEqual({ status: "failed", error: failure });
    expect(adapter.onRuntimeStop).not.toHaveBeenCalled();

    // The masked `true` used to be cached in the single-flight slot and replayed
    // to every later caller, hiding the failure for the life of the instance.
    await expect(runtime.stop()).rejects.toBe(failure);

    // A restart re-arms teardown: the failure is reported, not latched.
    adapter.onStarted.mockImplementation(async () => undefined);
    await runtime.start(adapter as never);
    await expect(runtime.stop()).resolves.toBe(true);
    expect(adapter.onRuntimeStop).toHaveBeenCalledTimes(1);
  });

  it("stop() after a failed start reports the failure instead of a masked true", async () => {
    const transport = new FakeTransport();
    const runtime = makePlatformRuntime(transport);
    const failure = new Error("adapter onStarted failed");
    const adapter = makeAdapter();
    adapter.onStarted.mockImplementation(async () => {
      throw failure;
    });

    // The start settles before any stop() is made, so stop() reaches the failed
    // state directly instead of via a park on an in-flight start.
    await expect(runtime.start(adapter as never)).rejects.toBe(failure);
    expect(runtime.state).toEqual({ status: "failed", error: failure });

    // Nothing was built, so there is no teardown to run — but a graceful `true`
    // while `state` reads "failed" is the discrepancy this rejects instead.
    await expect(runtime.stop()).rejects.toBe(failure);
    expect(runtime.state).toEqual({ status: "failed", error: failure });
    expect(adapter.onRuntimeStop).not.toHaveBeenCalled();

    // The replayed rejection is the same Error instance, not a re-wrapped copy.
    await expect(runtime.stop()).rejects.toBe(failure);
  });
});

describe("AgentRuntime lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("start() does not resolve a pending waitUntilStopped()", async () => {
    const transport = new FakeTransport();
    const runtime = makeAgentRuntime(transport);

    let resolved = false;
    const waiter = runtime.waitUntilStopped().then(() => {
      resolved = true;
    });

    await runtime.start();
    await settleWindow();

    expect(resolved).toBe(false);
    expect(runtime.state).toEqual({ status: "running" });

    await runtime.stop();
    await waiter;
    expect(resolved).toBe(true);
  });

  it("waitUntilStopped resolves because the runtime is stopped, distinguishably from never started", async () => {
    const transport = new FakeTransport();
    const neverStarted = makeAgentRuntime(transport);
    expect(neverStarted.state).toEqual({ status: "not_started" });

    let neverStartedResolved = false;
    void neverStarted.waitUntilStopped().then(() => {
      neverStartedResolved = true;
    });
    await settleWindow();
    expect(neverStartedResolved).toBe(false);

    const runtime = makeAgentRuntime(transport);
    await runtime.start();
    await runtime.stop();

    expect(runtime.state).toEqual({ status: "stopped" });
    await expect(runtime.waitUntilStopped()).resolves.toBeUndefined();
  });

  it("a restarted runtime does not resolve waitUntilStopped from the previous run", async () => {
    const transport = new FakeTransport();
    const runtime = makeAgentRuntime(transport);

    await runtime.start();
    await runtime.stop();
    expect(runtime.state).toEqual({ status: "stopped" });

    const connectGate = createGate();
    transport.beforeConnect = () => connectGate.wait();

    const restart = runtime.start();
    await yieldToEventLoop();

    // Started while the consume loop does not exist yet: the wait must track the
    // new run, not the terminal state the previous one left behind.
    let resolved = false;
    const waiter = runtime.waitUntilStopped().then(() => {
      resolved = true;
    });
    await settleWindow();
    expect(resolved).toBe(false);

    transport.beforeConnect = undefined;
    connectGate.release();
    await restart;
    expect(runtime.state).toEqual({ status: "running" });
    expect(resolved).toBe(false);

    await runtime.stop();
    await waiter;
    expect(resolved).toBe(true);
  });

  it("a fatal runtime error surfaces through waitUntilStopped and the failed state", async () => {
    const transport = new FakeTransport();
    const failure = new Error("adapter exploded");
    const runtime = makeAgentRuntime(transport, {
      onExecute: async () => {
        throw failure;
      },
    });

    await runtime.start();
    const waiter = runtime.waitUntilStopped();

    await emitRoomAdded(transport, ROOM_ID);
    await emitMessage(transport, ROOM_ID, "m-fail", "explode");

    await expect(waiter).rejects.toBe(failure);
    expect(runtime.state).toEqual({ status: "failed", error: failure });
  });

  it("a concurrent stop mirrors the in-flight stop, error identity included", async () => {
    const transport = new FakeTransport();
    const runtime = makeAgentRuntime(transport);
    const failure = new Error("disconnect failed");
    await runtime.start();

    const disconnectGate = createGate();
    vi.spyOn(transport, "disconnect").mockImplementation(async () => {
      await disconnectGate.wait();
      throw failure;
    });

    const settled: string[] = [];
    const first = runtime.stop().then(
      () => settled.push("first-ok"),
      (error: unknown) => {
        settled.push("first");
        return error;
      },
    );
    const second = runtime.stop().then(
      () => settled.push("second-ok"),
      (error: unknown) => {
        settled.push("second");
        return error;
      },
    );

    await settleWindow();
    expect(settled).toEqual([]);

    disconnectGate.release();
    const firstError = await first;
    const secondError = await second;

    expect(settled).toEqual(["first", "second"]);
    expect(firstError).toBe(failure);
    expect(secondError).toBe(failure);
  });

  it("start() while a stop is in flight rejects with RuntimeStateError", async () => {
    const transport = new FakeTransport();
    const runtime = makeAgentRuntime(transport);
    await runtime.start();

    const disconnectGate = createGate();
    vi.spyOn(transport, "disconnect").mockImplementation(async () => {
      await disconnectGate.wait();
    });

    const stopPromise = runtime.stop();
    expect(runtime.state).toEqual({ status: "stopping" });
    await expect(runtime.start()).rejects.toBeInstanceOf(RuntimeStateError);

    disconnectGate.release();
    await expect(stopPromise).resolves.toBe(true);
  });

  it("a post-stop enqueue on the consume path fails the runtime instead of going unhandled", async () => {
    const transport = new FakeTransport();
    const runtime = makeAgentRuntime(transport);
    const rejection = new RuntimeStateError(
      `Execution for room ${ROOM_ID} has already ended (status: stopped); enqueue() is a no-op after stop()`,
    );
    vi.spyOn(Execution.prototype, "enqueue").mockRejectedValue(rejection);

    await withoutUnhandledRejections(async () => {
      await runtime.start();
      await emitRoomAdded(transport, ROOM_ID);
      await emitMessage(transport, ROOM_ID, "m1", "hello");
      await settleWindow();
    });

    expect(runtime.state).toEqual({ status: "failed", error: rejection });
  });

  it("a failed room execution does not abort teardown of the other rooms or the link", async () => {
    const transport = new FakeTransport();
    const failure = new Error("handler exploded");
    const cleanedRooms: string[] = [];
    const runtime = makeAgentRuntime(transport, {
      onExecute: async (_context, event) => {
        if (event.roomId === ROOM_ID) {
          throw failure;
        }
      },
      onSessionCleanup: async (roomId) => {
        cleanedRooms.push(roomId);
      },
    });

    await runtime.start();
    for (const roomId of [ROOM_ID, "room-2"]) {
      await emitRoomAdded(transport, roomId);
    }

    // Fails room-1's Execution (and with it the runtime) before any stop() call.
    await emitMessage(transport, ROOM_ID, "m-fail", "explode");
    await settleWindow();
    expect(runtime.state).toEqual({ status: "failed", error: failure });

    const disconnectsBefore = transport.disconnectCount;
    await expect(runtime.stop()).rejects.toBe(failure);

    // room-1's rejecting stop() must not have skipped the rest of the teardown.
    expect(cleanedRooms.sort()).toEqual([ROOM_ID, "room-2"]);
    expect(transport.disconnectCount - disconnectsBefore).toBe(1);
    expect(transport.isConnected()).toBe(false);
    expect(runtime.getContexts()).toEqual([]);
  });

  it("stop() during the early window of a start does not report a stopped runtime that is still live", async () => {
    const transport = new FakeTransport();
    const runtime = makeAgentRuntime(transport);

    const connectGate = createGate();
    transport.beforeConnect = () => connectGate.wait();

    const startPromise = runtime.start();
    await yieldToEventLoop();
    expect(runtime.state).toEqual({ status: "starting" });

    const settled: string[] = [];
    const stopPromise = runtime.stop().then((value) => {
      settled.push("stop");
      return value;
    });

    await settleWindow();
    expect(settled).toEqual([]);
    expect(runtime.state).toEqual({ status: "starting" });

    transport.beforeConnect = undefined;
    connectGate.release();
    await startPromise;
    await expect(stopPromise).resolves.toBe(true);

    expect(runtime.state).toEqual({ status: "stopped" });
    expect(transport.isConnected()).toBe(false);
  });
});

describe("Agent lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeStubRuntime(overrides?: {
    start?: () => Promise<void>;
    stop?: () => Promise<boolean>;
  }) {
    return {
      agentId: AGENT_ID,
      name: "test",
      description: "test",
      contactConfiguration: undefined,
      isContactsSubscribed: false,
      start: vi.fn(overrides?.start ?? (async () => undefined)),
      stop: vi.fn(overrides?.stop ?? (async () => true)),
      runForever: vi.fn(async () => undefined),
    };
  }

  function makeAgent(runtime: ReturnType<typeof makeStubRuntime>): Agent {
    return new Agent(runtime as never, makeAdapter() as never);
  }

  it("isRunning is false during an in-flight start, true once started, false once stopped", async () => {
    const startGate = createGate();
    const runtime = makeStubRuntime({
      start: async () => {
        await startGate.wait();
      },
    });
    const agent = makeAgent(runtime);

    const startPromise = agent.start();
    expect(agent.isRunning).toBe(false);
    expect(agent.state).toEqual({ status: "starting" });

    startGate.release();
    await startPromise;
    expect(agent.isRunning).toBe(true);
    expect(agent.state).toEqual({ status: "running" });

    await agent.stop();
    expect(agent.isRunning).toBe(false);
    expect(agent.state).toEqual({ status: "stopped" });
  });

  it("a rejected stop is not reported as a completed one", async () => {
    const failure = new Error("platform stop failed");
    const runtime = makeStubRuntime({
      stop: async () => {
        throw failure;
      },
    });
    const agent = makeAgent(runtime);

    await agent.start();
    await expect(agent.stop()).rejects.toBe(failure);
    expect(agent.state).toEqual({ status: "failed", error: failure });

    await expect(agent.stop()).rejects.toBe(failure);
    expect(runtime.stop).toHaveBeenCalledTimes(1);
  });

  it("stop() after a failed start reports the failure instead of a masked true", async () => {
    const failure = new Error("platform start failed");
    const runtime = makeStubRuntime({
      start: async () => {
        throw failure;
      },
    });
    const agent = makeAgent(runtime);

    await expect(agent.start()).rejects.toBe(failure);
    expect(agent.state).toEqual({ status: "failed", error: failure });

    // PlatformRuntime already ran its own cleanup, so there is nothing left to
    // stop — but reporting a graceful shutdown while `state` says "failed" is
    // the discrepancy this rejects instead.
    await expect(agent.stop()).rejects.toBe(failure);
    expect(agent.state).toEqual({ status: "failed", error: failure });
    expect(runtime.stop).not.toHaveBeenCalled();
  });

  it("stop() parked on a start that then fails reports the failure instead of a masked true", async () => {
    const failure = new Error("platform start failed");
    const startGate = createGate();
    const runtime = makeStubRuntime({
      start: async () => {
        await startGate.wait();
        throw failure;
      },
    });
    const agent = makeAgent(runtime);

    const startOutcome = rejectionOf(agent.start());
    expect(agent.state).toEqual({ status: "starting" });
    const stopOutcome = rejectionOf(agent.stop());
    startGate.release();

    expect(await startOutcome).toBe(failure);
    expect(await stopOutcome).toBe(failure);
    expect(agent.state).toEqual({ status: "failed", error: failure });
    expect(runtime.stop).not.toHaveBeenCalled();
  });

  it("start() while a stop is in flight rejects with RuntimeStateError", async () => {
    const stopGate = createGate();
    const runtime = makeStubRuntime({
      stop: async () => {
        await stopGate.wait();
        return true;
      },
    });
    const agent = makeAgent(runtime);

    await agent.start();
    const stopPromise = agent.stop();
    expect(agent.state).toEqual({ status: "stopping" });

    await expect(agent.start()).rejects.toBeInstanceOf(RuntimeStateError);

    stopGate.release();
    await expect(stopPromise).resolves.toBe(true);
  });
});

describe("Execution lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("enqueue after stop rejects with a RuntimeStateError naming the room", async () => {
    const execution = makeExecution();
    await execution.stop();

    expect(execution.state).toEqual({ status: "stopped", graceful: true });
    await expect(execution.enqueue(makeExecutionEvent("m1"))).rejects.toThrow(ROOM_ID);
    await expect(execution.enqueue(makeExecutionEvent("m1"))).rejects.toBeInstanceOf(RuntimeStateError);
  });

  it("a timed-out stop lands in a terminal state a third party can read as non-graceful", async () => {
    const executeGate = createGate();

    await withoutUnhandledRejections(async () => {
      const execution = makeExecution(async () => {
        await executeGate.wait();
        throw new Error("stuck handler eventually failed");
      });

      await execution.enqueue(makeExecutionEvent("m1"));
      await expect(execution.stop(FORCED_STOP_TIMEOUT_MS)).resolves.toBe(false);

      // A caller that never held the boolean can still tell the stop was forced.
      expect(execution.state).toEqual({ status: "stopped", graceful: false });
      await expect(execution.waitUntilStopped()).resolves.toBeUndefined();
      await expect(execution.stop()).resolves.toBe(false);

      executeGate.release();
    });
  });

  it("concurrent stops share one outcome", async () => {
    const executeGate = createGate();
    const execution = makeExecution(async () => {
      await executeGate.wait();
    });

    await execution.enqueue(makeExecutionEvent("m1"));
    const first = execution.stop();
    const second = execution.stop();

    executeGate.release();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(execution.state).toEqual({ status: "stopped", graceful: true });
  });
});
