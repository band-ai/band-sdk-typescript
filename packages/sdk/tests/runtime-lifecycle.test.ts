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
import { PlatformRuntime } from "../src/runtime/PlatformRuntime";
import { AgentRuntime } from "../src/runtime/rooms/AgentRuntime";
import { MessageRetryTracker } from "../src/runtime/retryTracker";
import {
  isLegalExecutionTransition,
  isLegalRuntimeTransition,
  type ExecutionLifecycleStatus,
  type RuntimeLifecycleStatus,
} from "../src/runtime/lifecycle";
// AC-19: the union must be one declaration, reachable from both public entry points.
import type { RuntimeLifecycleState as RootLifecycleState } from "../src/index";
import type { RuntimeLifecycleState as RuntimeSubpathLifecycleState } from "../src/runtime/index";
import { FakeRestApi } from "./testUtils";

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
    agentId: "a1",
    apiKey: "k",
    transport,
    restApi: new FakeRestApi(),
  });
}

function makePlatformRuntime(transport: StreamingTransport): PlatformRuntime {
  return new PlatformRuntime({ agentId: "a1", apiKey: "k", link: makeLink(transport) });
}

function makeAgentRuntime(transport: StreamingTransport): AgentRuntime {
  return new AgentRuntime({
    link: makeLink(transport),
    agentId: "a1",
    onExecute: async () => undefined,
  });
}

function makeExecutionEvent(id: string, roomId = "room-1"): PlatformEvent {
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
    roomId: "room-1",
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
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off("unhandledRejection", listener);
  }

  expect(seen).toEqual([]);
}

describe("lifecycle state machine", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // AC-8: adding a status without a case in the transition switch fails `tsc`,
  // because the switch's default branch narrows to `never`. These maps are the
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

  it("AC-8: every declared status is handled by its transition table", () => {
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

  it("AC-7: the replaced lifecycle booleans no longer exist on the four classes", async () => {
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

  it("AC-11/AC-18: all four classes expose a public state getter with a `status` discriminant", async () => {
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

  it("AC-19: the lifecycle union is the same declaration on both public entry points", () => {
    const fromRoot: RootLifecycleState = { status: "running" };
    const fromSubpath: RuntimeSubpathLifecycleState = fromRoot;
    const backToRoot: RootLifecycleState = fromSubpath;

    expect(backToRoot.status).toBe("running");
  });

  it("AC-20: Execution and ExecutionContext state vocabularies are disjoint and cross-referenced", () => {
    const lifecycleNames = Object.keys(EXECUTION_STATUSES);
    const perTurnNames: ExecutionState[] = ["starting", "idle", "processing"];
    expect(lifecycleNames.filter((name) => perTurnNames.includes(name as ExecutionState))).toEqual([]);

    const srcDir = join(__dirname, "../src/runtime");
    expect(readFileSync(join(srcDir, "Execution.ts"), "utf8")).toContain("@see ExecutionContext.state");
    expect(readFileSync(join(srcDir, "ExecutionContext.ts"), "utf8")).toContain("@see Execution.state");
  });

  it("AC-28: the value returned by state is immutable from the caller's perspective", async () => {
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

  it("AC-1: a failed stop does not disable teardown on the next start/stop cycle", async () => {
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

  it("AC-2: a failed start whose cleanup also failed does not poison the instance", async () => {
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

  it("AC-3: a concurrent stop awaits the in-flight teardown instead of reporting success", async () => {
    const transport = new FakeTransport();
    const runtime = makePlatformRuntime(transport);
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const adapter = makeAdapter(async () => {
      await cleanupGate;
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

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toEqual([]);

    releaseCleanup();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(settled).toEqual(["first", "second"]);
    expect(adapter.onRuntimeStop).toHaveBeenCalledTimes(1);
  });

  it("AC-23: coalesced stop callers receive the identical Error instance", async () => {
    const transport = new FakeTransport();
    const runtime = makePlatformRuntime(transport);
    const failure = new Error("adapter cleanup failed");
    const adapter = makeAdapter(async () => {
      throw failure;
    });

    await runtime.start(adapter as never);

    const first = runtime.stop();
    const second = runtime.stop();

    const firstError = await first.then(() => null, (error: unknown) => error);
    const secondError = await second.then(() => null, (error: unknown) => error);

    expect(firstError).toBe(failure);
    expect(secondError).toBe(firstError);
  });

  it("AC-24: start() while a stop is in flight rejects with RuntimeStateError", async () => {
    const transport = new FakeTransport();
    const runtime = makePlatformRuntime(transport);
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const adapter = makeAdapter(async () => {
      await cleanupGate;
    });

    await runtime.start(adapter as never);
    const stopPromise = runtime.stop();
    expect(runtime.state).toEqual({ status: "stopping" });

    await expect(runtime.start(adapter as never)).rejects.toBeInstanceOf(RuntimeStateError);

    releaseCleanup();
    await expect(stopPromise).resolves.toBe(true);
  });

  it("AC-25: an external stop coalesces with the internal cleanup stop of a failing start", async () => {
    const transport = new FakeTransport();
    const runtime = makePlatformRuntime(transport);
    const adapter = makeAdapter();

    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    vi.spyOn(AgentRuntime.prototype, "start").mockImplementation(async () => {
      await startGate;
      throw new Error("runtime start failed");
    });

    const startPromise = runtime.start(adapter as never);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // External caller races the cleanup stop() that start()'s own failure path runs.
    const externalStop = runtime.stop();
    releaseStart();

    await expect(startPromise).rejects.toThrow("runtime start failed");
    await expect(externalStop).resolves.toBe(true);
    expect(adapter.onRuntimeStop).toHaveBeenCalledTimes(1);
  });

  it("AC-22: a post-stop enqueue on the contact hub path is handled, not left unhandled", async () => {
    const transport = new FakeTransport();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const runtime = new PlatformRuntime({
      agentId: "a1",
      apiKey: "k",
      link: makeLink(transport),
      logger,
      contactConfig: { strategy: "hub_room", hubTaskId: "task-1" },
    });
    const adapter = makeAdapter();

    vi.spyOn(AgentRuntime.prototype, "enqueueEvent").mockRejectedValue(
      new RuntimeStateError("Execution for room hub has already ended (status: stopped); enqueue() is a no-op after stop()"),
    );

    await withoutUnhandledRejections(async () => {
      await runtime.start(adapter as never);
      await transport.emit("agent_contacts:a1", "contact_request_received", {
        id: "req-1",
        from_handle: "alice",
        from_name: "Alice",
        message: "Hello!",
        status: "pending",
        inserted_at: new Date().toISOString(),
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
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
    let releaseStarted!: () => void;
    const startedGate = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    const adapter = makeAdapter();
    adapter.onStarted.mockImplementation(async () => {
      await startedGate;
    });

    // Held before `activeAdapter`/`runtime` are assigned: the window in which
    // stop() used to short-circuit to "stopped" while start() built a live runtime.
    const startPromise = runtime.start(adapter as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.state).toEqual({ status: "starting" });

    const settled: string[] = [];
    const stopPromise = runtime.stop().then((value) => {
      settled.push("stop");
      return value;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toEqual([]);
    expect(runtime.state).toEqual({ status: "starting" });

    releaseStarted();
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
    let releaseStarted!: () => void;
    const startedGate = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    const adapter = makeAdapter();
    adapter.onStarted.mockImplementation(async () => {
      await startedGate;
      throw failure;
    });

    // Fails before `activeAdapter`/`runtime` are assigned, so there is nothing to
    // tear down — but the parked stop() must not read that as a graceful shutdown.
    const startPromise = runtime.start(adapter as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.state).toEqual({ status: "starting" });

    const startOutcome = startPromise.then(() => null, (error: unknown) => error);
    const stopOutcome = runtime.stop().then(() => null, (error: unknown) => error);
    releaseStarted();

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

  it("AC-5: start() does not resolve a pending waitUntilStopped()", async () => {
    const transport = new FakeTransport();
    const runtime = makeAgentRuntime(transport);

    let resolved = false;
    const waiter = runtime.waitUntilStopped().then(() => {
      resolved = true;
    });

    await runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(resolved).toBe(false);
    expect(runtime.state).toEqual({ status: "running" });

    await runtime.stop();
    await waiter;
    expect(resolved).toBe(true);
  });

  it("AC-6: waitUntilStopped resolves because the runtime is stopped, distinguishably from never started", async () => {
    const transport = new FakeTransport();
    const neverStarted = makeAgentRuntime(transport);
    expect(neverStarted.state).toEqual({ status: "not_started" });

    let neverStartedResolved = false;
    void neverStarted.waitUntilStopped().then(() => {
      neverStartedResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(neverStartedResolved).toBe(false);

    const runtime = makeAgentRuntime(transport);
    await runtime.start();
    await runtime.stop();

    expect(runtime.state).toEqual({ status: "stopped" });
    await expect(runtime.waitUntilStopped()).resolves.toBeUndefined();
  });

  it("AC-5: a restarted runtime does not resolve waitUntilStopped from the previous run", async () => {
    const transport = new FakeTransport();
    const runtime = makeAgentRuntime(transport);

    await runtime.start();
    await runtime.stop();
    expect(runtime.state).toEqual({ status: "stopped" });

    let releaseConnect!: () => void;
    transport.beforeConnect = () => new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });

    const restart = runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Started while the consume loop does not exist yet: the wait must track the
    // new run, not the terminal state the previous one left behind.
    let resolved = false;
    const waiter = runtime.waitUntilStopped().then(() => {
      resolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolved).toBe(false);

    transport.beforeConnect = undefined;
    releaseConnect();
    await restart;
    expect(runtime.state).toEqual({ status: "running" });
    expect(resolved).toBe(false);

    await runtime.stop();
    await waiter;
    expect(resolved).toBe(true);
  });

  it("AC-6: a fatal runtime error surfaces through waitUntilStopped and the failed state", async () => {
    const transport = new FakeTransport();
    const failure = new Error("adapter exploded");
    const runtime = new AgentRuntime({
      link: makeLink(transport),
      agentId: "a1",
      onExecute: async () => {
        throw failure;
      },
    });

    await runtime.start();
    const waiter = runtime.waitUntilStopped();

    await transport.emit("agent_rooms:a1", "room_added", {
      id: "room-1",
      status: "active",
      type: "direct",
      title: "Room",
      removed_at: "",
    });
    await transport.emit("chat_room:room-1", "message_created", {
      id: "m-fail",
      content: "explode",
      message_type: "text",
      sender_id: "u1",
      sender_type: "User",
      sender_name: "Jane",
      inserted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    await expect(waiter).rejects.toBe(failure);
    expect(runtime.state).toEqual({ status: "failed", error: failure });
  });

  it("AC-4/AC-23: a concurrent stop mirrors the in-flight stop, error identity included", async () => {
    const transport = new FakeTransport();
    const runtime = makeAgentRuntime(transport);
    const failure = new Error("disconnect failed");
    await runtime.start();

    let releaseDisconnect!: () => void;
    const disconnectGate = new Promise<void>((resolve) => {
      releaseDisconnect = resolve;
    });
    vi.spyOn(transport, "disconnect").mockImplementation(async () => {
      await disconnectGate;
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

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toEqual([]);

    releaseDisconnect();
    const firstError = await first;
    const secondError = await second;

    expect(settled).toEqual(["first", "second"]);
    expect(firstError).toBe(failure);
    expect(secondError).toBe(failure);
  });

  it("AC-24: start() while a stop is in flight rejects with RuntimeStateError", async () => {
    const transport = new FakeTransport();
    const runtime = makeAgentRuntime(transport);
    await runtime.start();

    let releaseDisconnect!: () => void;
    const disconnectGate = new Promise<void>((resolve) => {
      releaseDisconnect = resolve;
    });
    vi.spyOn(transport, "disconnect").mockImplementation(async () => {
      await disconnectGate;
    });

    const stopPromise = runtime.stop();
    expect(runtime.state).toEqual({ status: "stopping" });
    await expect(runtime.start()).rejects.toBeInstanceOf(RuntimeStateError);

    releaseDisconnect();
    await expect(stopPromise).resolves.toBe(true);
  });

  it("AC-22: a post-stop enqueue on the consume path fails the runtime instead of going unhandled", async () => {
    const transport = new FakeTransport();
    const runtime = makeAgentRuntime(transport);
    const rejection = new RuntimeStateError(
      "Execution for room room-1 has already ended (status: stopped); enqueue() is a no-op after stop()",
    );
    vi.spyOn(Execution.prototype, "enqueue").mockRejectedValue(rejection);

    await withoutUnhandledRejections(async () => {
      await runtime.start();
      await transport.emit("agent_rooms:a1", "room_added", {
        id: "room-1",
        status: "active",
        type: "direct",
        title: "Room",
        removed_at: "",
      });
      await transport.emit("chat_room:room-1", "message_created", {
        id: "m1",
        content: "hello",
        message_type: "text",
        sender_id: "u1",
        sender_type: "User",
        sender_name: "Jane",
        inserted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(runtime.state).toEqual({ status: "failed", error: rejection });
  });

  it("a failed room execution does not abort teardown of the other rooms or the link", async () => {
    const transport = new FakeTransport();
    const failure = new Error("handler exploded");
    const cleanedRooms: string[] = [];
    const runtime = new AgentRuntime({
      link: makeLink(transport),
      agentId: "a1",
      onExecute: async (_context, event) => {
        if (event.roomId === "room-1") {
          throw failure;
        }
      },
      onSessionCleanup: async (roomId) => {
        cleanedRooms.push(roomId);
      },
    });

    await runtime.start();
    for (const roomId of ["room-1", "room-2"]) {
      await transport.emit("agent_rooms:a1", "room_added", {
        id: roomId,
        status: "active",
        type: "direct",
        title: "Room",
        removed_at: "",
      });
    }

    // Fails room-1's Execution (and with it the runtime) before any stop() call.
    await transport.emit("chat_room:room-1", "message_created", {
      id: "m-fail",
      content: "explode",
      message_type: "text",
      sender_id: "u1",
      sender_type: "User",
      sender_name: "Jane",
      inserted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runtime.state).toEqual({ status: "failed", error: failure });

    const disconnectsBefore = transport.disconnectCount;
    await expect(runtime.stop()).rejects.toBe(failure);

    // room-1's rejecting stop() must not have skipped the rest of the teardown.
    expect(cleanedRooms.sort()).toEqual(["room-1", "room-2"]);
    expect(transport.disconnectCount - disconnectsBefore).toBe(1);
    expect(transport.isConnected()).toBe(false);
    expect(runtime.getContexts()).toEqual([]);
  });

  it("stop() during the early window of a start does not report a stopped runtime that is still live", async () => {
    const transport = new FakeTransport();
    const runtime = makeAgentRuntime(transport);

    let releaseConnect!: () => void;
    transport.beforeConnect = () => new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });

    const startPromise = runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.state).toEqual({ status: "starting" });

    const settled: string[] = [];
    const stopPromise = runtime.stop().then((value) => {
      settled.push("stop");
      return value;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toEqual([]);
    expect(runtime.state).toEqual({ status: "starting" });

    transport.beforeConnect = undefined;
    releaseConnect();
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
      agentId: "a1",
      name: "test",
      description: "test",
      contactConfiguration: undefined,
      isContactsSubscribed: false,
      start: vi.fn(overrides?.start ?? (async () => undefined)),
      stop: vi.fn(overrides?.stop ?? (async () => true)),
      runForever: vi.fn(async () => undefined),
    };
  }

  it("AC-13/AC-21: isRunning is false during an in-flight start, true once started, false once stopped", async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const runtime = makeStubRuntime({
      start: async () => {
        await startGate;
      },
    });
    const agent = new Agent(runtime as never, makeAdapter() as never);

    const startPromise = agent.start();
    expect(agent.isRunning).toBe(false);
    expect(agent.state).toEqual({ status: "starting" });

    releaseStart();
    await startPromise;
    expect(agent.isRunning).toBe(true);
    expect(agent.state).toEqual({ status: "running" });

    await agent.stop();
    expect(agent.isRunning).toBe(false);
    expect(agent.state).toEqual({ status: "stopped" });
  });

  it("AC-12/AC-23: a rejected stop is not reported as a completed one", async () => {
    const failure = new Error("platform stop failed");
    const runtime = makeStubRuntime({
      stop: async () => {
        throw failure;
      },
    });
    const agent = new Agent(runtime as never, makeAdapter() as never);

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
    const agent = new Agent(runtime as never, makeAdapter() as never);

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
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const runtime = makeStubRuntime({
      start: async () => {
        await startGate;
        throw failure;
      },
    });
    const agent = new Agent(runtime as never, makeAdapter() as never);

    const startOutcome = agent.start().then(() => null, (error: unknown) => error);
    expect(agent.state).toEqual({ status: "starting" });
    const stopOutcome = agent.stop().then(() => null, (error: unknown) => error);
    releaseStart();

    expect(await startOutcome).toBe(failure);
    expect(await stopOutcome).toBe(failure);
    expect(agent.state).toEqual({ status: "failed", error: failure });
    expect(runtime.stop).not.toHaveBeenCalled();
  });

  it("AC-24: start() while a stop is in flight rejects with RuntimeStateError", async () => {
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const runtime = makeStubRuntime({
      stop: async () => {
        await stopGate;
        return true;
      },
    });
    const agent = new Agent(runtime as never, makeAdapter() as never);

    await agent.start();
    const stopPromise = agent.stop();
    expect(agent.state).toEqual({ status: "stopping" });

    await expect(agent.start()).rejects.toBeInstanceOf(RuntimeStateError);

    releaseStop();
    await expect(stopPromise).resolves.toBe(true);
  });
});

describe("Execution lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("AC-9: enqueue after stop rejects with a RuntimeStateError naming the room", async () => {
    const execution = makeExecution();
    await execution.stop();

    expect(execution.state).toEqual({ status: "stopped", graceful: true });
    await expect(execution.enqueue(makeExecutionEvent("m1"))).rejects.toThrow(/room-1/);
    await expect(execution.enqueue(makeExecutionEvent("m1"))).rejects.toBeInstanceOf(RuntimeStateError);
  });

  it("AC-10/AC-26: a timed-out stop lands in a terminal state a third party can read as non-graceful", async () => {
    let releaseExecute!: () => void;
    const executeGate = new Promise<void>((resolve) => {
      releaseExecute = resolve;
    });

    await withoutUnhandledRejections(async () => {
      const execution = makeExecution(async () => {
        await executeGate;
        throw new Error("stuck handler eventually failed");
      });

      await execution.enqueue(makeExecutionEvent("m1"));
      await expect(execution.stop(10)).resolves.toBe(false);

      // A caller that never held the boolean can still tell the stop was forced.
      expect(execution.state).toEqual({ status: "stopped", graceful: false });
      await expect(execution.waitUntilStopped()).resolves.toBeUndefined();
      await expect(execution.stop()).resolves.toBe(false);

      releaseExecute();
    });
  });

  it("AC-3-style coalescing: concurrent stops share one outcome", async () => {
    let releaseExecute!: () => void;
    const executeGate = new Promise<void>((resolve) => {
      releaseExecute = resolve;
    });
    const execution = makeExecution(async () => {
      await executeGate;
    });

    await execution.enqueue(makeExecutionEvent("m1"));
    const first = execution.stop();
    const second = execution.stop();

    releaseExecute();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(execution.state).toEqual({ status: "stopped", graceful: true });
  });
});
