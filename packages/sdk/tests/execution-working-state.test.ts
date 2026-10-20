import { AGENT_ID, AGENT_API_KEY, BandPlatform, person } from "./flows/support/bandPlatform";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GenericAdapter } from "../src/adapters/GenericAdapter";
import { PlatformRuntime } from "../src/runtime/PlatformRuntime";
import { DefaultPreprocessor } from "../src/runtime/preprocessing/DefaultPreprocessor";
import { ExecutionContext } from "../src/runtime/ExecutionContext";
import { Execution } from "../src/runtime/Execution";
import { BandLink } from "../src/platform/BandLink";
import { createDeferred } from "../src/core/deferred";
import { retainWorkingCycleUntil } from "../src/runtime/workingState";
import type { Preprocessor } from "../src/contracts/protocols";
import type { PlatformEvent } from "../src/platform/events";
import type { SessionConfig } from "../src/runtime/types";
import { FakeRestApi, FakeTransport, makeMessage, RecordLog } from "./testUtils";

const room = "room-1";
afterEach(() => vi.useRealTimers());

async function fixture(options: {
  preprocessor?: Preprocessor<PlatformEvent>;
  sessionConfig?: SessionConfig;
  mark?: () => Promise<void>;
  report?: (working: boolean) => Promise<void>;
} = {}) {
  const log = new RecordLog<string>();
  const transport = new FakeTransport();
  const rest = new FakeRestApi({
    markMessageProcessing: async () => { log.record("processing"); await options.mark?.(); return {}; },
    markMessageProcessed: async () => { log.record("processed"); return {}; },
    markMessageFailed: async () => { log.record("failed"); return {}; },
  }, { id: "a1", name: "Agent", description: null });
  // Install the optional endpoint on the transport double, leaving SDK dispatch real.
  Object.assign(rest, { reportActivity: async (_room: string, working: boolean) => {
    log.record(String(working));
    await options.report?.(working);
    return { working };
  } });
  const actualLink = new BandLink({ agentId: "a1", apiKey: "k", restApi: rest, transport });
  const contexts: ExecutionContext[] = [];
  const runtime = new PlatformRuntime({ agentId: "a1", apiKey: "k", link: actualLink,
    preprocessor: options.preprocessor, sessionConfig: options.sessionConfig,
    contextFactory: (_id, defaults) => { const context = new ExecutionContext(defaults); contexts.push(context); return context; },
  });
  return { runtime, log, transport, contexts };
}

function message(id = "m1") { return { ...makeMessage("hello"), id }; }

describe("execution-owned working state", () => {
  it.each([false, true])("orders automatic true/false before terminal marks (adapter fails: %s)", async (fails) => {
    const f = await fixture();
    const entered = createDeferred();
    const release = createDeferred();
    const error = new Error("original provider failure");
    await f.runtime.start(new GenericAdapter(async ({ tools }) => {
      f.log.record("adapter"); entered.resolve(); await release.promise;
      if (fails) throw error;
      tools.turn.settle();
    }));
    try {
      const run = f.runtime.bootstrapRoomMessage(room, message());
      await entered.promise;
      expect(f.log.entries).toEqual(["processing", "true", "adapter"]);
      release.resolve(); await run;
      expect(f.log.entries).toEqual(["processing", "true", "adapter", "false", fails ? "failed" : "processed"]);
    } finally { release.resolve(); await f.runtime.stop(0); }
  });

  it.each(["preprocess", "mark", "initial report"])("fences admission after forced teardown during %s", async (phase) => {
    const entered = createDeferred();
    const release = createDeferred();
    const preprocessor = new DefaultPreprocessor();
    const hold = async () => { entered.resolve(); await release.promise; };
    const f = await fixture({
      preprocessor: phase === "preprocess" ? { process: async (...args) => { await hold(); return preprocessor.process(...args); } } : undefined,
      mark: phase === "mark" ? hold : undefined,
      report: phase === "initial report" ? async (working) => { if (working) await hold(); } : undefined,
    });
    const handler = vi.fn(async ({ tools }) => { tools.turn.settle(); });
    await f.runtime.start(new GenericAdapter(handler));
    const run = f.runtime.bootstrapRoomMessage(room, message());
    await entered.promise;
    const reset = f.runtime.resetRoomSession(room, 0);
    if (phase === "initial report") {
      // The independent HTTP budget owns this await; this boundary double is released explicitly.
      release.resolve();
    }
    await reset;
    release.resolve(); await run;
    expect(handler).not.toHaveBeenCalled();
    expect(f.log.entries).not.toContain("processed");
    expect(f.log.entries.filter((entry) => entry === "true")).toHaveLength(phase === "initial report" ? 1 : 0);
    await f.runtime.stop(0);
  });

  it("retains through control delivery, then closes before disconnect on forced stop", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const provider = createDeferred();
    let calls = 0;
    let retained: Promise<void> | undefined;
    await f.runtime.start(new GenericAdapter(async ({ tools }) => {
      if (++calls === 1) retained = retainWorkingCycleUntil(tools, provider.promise);
      tools.turn.settle();
    }));
    await f.runtime.bootstrapRoomMessage(room, message());
    expect(f.log.entries).toEqual(["processing", "true", "processed"]);
    await vi.advanceTimersByTimeAsync(6000);
    await f.runtime.bootstrapRoomMessage(room, message("control"));
    expect(f.log.entries.filter((entry) => entry === "false")).toHaveLength(0);
    await f.runtime.stop(0);
    expect(f.log.entries.at(-1)).toBe("false");
    const snapshot = [...f.log.entries];
    provider.resolve(); await retained;
    await vi.advanceTimersByTimeAsync(9000);
    expect(f.log.entries).toEqual(snapshot);
  });

  it("invalidates old provider cleanup after reset and keeps the replacement working", async () => {
    const f = await fixture();
    const providers = [createDeferred(), createDeferred()];
    const retained: Promise<void>[] = [];
    await f.runtime.start(new GenericAdapter(async ({ tools }) => {
      retained.push(retainWorkingCycleUntil(tools, providers[retained.length]!.promise));
      tools.turn.settle();
    }));
    await f.runtime.bootstrapRoomMessage(room, message());
    await f.runtime.resetRoomSession(room, 0);
    await f.runtime.bootstrapRoomMessage(room, message("replacement"));
    providers[0]!.resolve(); await retained[0];
    expect(f.log.entries.filter((entry) => entry === "false")).toHaveLength(1);
    providers[1]!.resolve(); await retained[1];
    expect(f.log.entries.filter((entry) => entry === "false")).toHaveLength(2);
    await f.runtime.stop(0);
  });

  it("excludes actual contact-hub synthetic and ordinary turns while ordinary rooms report", async () => {
    const transport = new FakeTransport();
    const reports = new RecordLog<{ roomId: string; working: boolean }>();
    const handled = new RecordLog<string>();
    const rest = new FakeRestApi({ createChat: async () => ({ id: "hub" }) }, { id: "a1", name: "Agent", description: null });
    Object.assign(rest, { reportActivity: async (roomId: string, working: boolean) => { reports.record({ roomId, working }); return { working }; } });
    const runtime = new PlatformRuntime({ agentId: "a1", apiKey: "k",
      link: new BandLink({ agentId: "a1", apiKey: "k", restApi: rest, transport }),
      contactConfig: { strategy: "hub_room", hubTaskId: "contact-task" },
    });
    await runtime.start(new GenericAdapter(async ({ message, tools }) => { handled.record(message.roomId); tools.turn.settle(); }));
    try {
      await transport.emit("agent_contacts:a1", "contact_request_received", {
        id: "request", from_handle: "alice", from_name: "Alice", message: "Hello", status: "pending", inserted_at: new Date().toISOString(),
      });
      await handled.next((id) => id === "hub");
      await runtime.bootstrapRoomMessage("hub", { ...message("ordinary-hub"), roomId: "hub" });
      await runtime.bootstrapRoomMessage(room, message("ordinary-room"));
      expect(handled.entries).toEqual(["hub", "hub", room]);
      expect(reports.entries).toEqual([{ roomId: room, working: true }, { roomId: room, working: false }]);
    } finally { await runtime.stop(0); }
  });

  it("does not report self or duplicate input", async () => {
    const f = await fixture();
    const handler = vi.fn(async ({ tools }) => { tools.turn.settle(); });
    await f.runtime.start(new GenericAdapter(handler));
    await f.runtime.bootstrapRoomMessage(room, { ...message("self"), senderId: "a1", senderType: "Agent" });
    await f.runtime.bootstrapRoomMessage(room, message());
    await f.runtime.bootstrapRoomMessage(room, message());
    expect(handler).toHaveBeenCalledTimes(1);
    expect(f.log.entries.filter((entry) => entry === "true")).toHaveLength(1);
    await f.runtime.stop(0);
  });

  it("keeps reporting cleanup independent of a stuck handler and preserves forced-stop outcome", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const entered = createDeferred();
    const release = createDeferred();
    await f.runtime.start(new GenericAdapter(async ({ tools }) => { entered.resolve(); await release.promise; tools.turn.settle(); }));
    const run = f.runtime.bootstrapRoomMessage(room, message());
    await entered.promise;
    const stop = f.runtime.stop(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await stop).toBe(false);
    expect(f.log.entries).toEqual(["processing", "true", "false"]);
    release.resolve(); await run;
    expect(f.log.entries).toEqual(["processing", "true", "false"]);
  });

  it("keeps overlapping bootstrap and backlog cycles working until both handlers finish", async () => {
    const platform = BandPlatform.host([person("user")]);
    const joined = await platform.room(room);
    const backlog = joined.postBeforeConnect("user", "backlog");
    const entered = new RecordLog<string>();
    const releases = new Map([[backlog, createDeferred()], ["bootstrap", createDeferred()]]);
    const runtime = new PlatformRuntime({ agentId: AGENT_ID, apiKey: AGENT_API_KEY, linkOptions: platform.link,
      agentConfig: { autoSubscribeExistingRooms: true },
    });
    await runtime.start(new GenericAdapter(async ({ message, tools }) => {
      entered.record(message.id);
      await releases.get(message.id)!.promise;
      tools.turn.settle();
    }));
    try {
      await entered.next((id) => id === backlog);
      const bootstrapping = runtime.bootstrapRoomMessage(room, { ...message("bootstrap"), senderId: "user" });
      await entered.next((id) => id === "bootstrap");
      expect(platform.rest.workingReports.entries.map((entry) => entry.working)).toEqual([true]);
      releases.get("bootstrap")!.resolve(); await bootstrapping;
      expect(platform.rest.workingReports.entries.map((entry) => entry.working)).toEqual([true]);
      releases.get(backlog)!.resolve(); await joined.outcome(backlog);
      expect(platform.rest.workingReports.entries.map((entry) => entry.working)).toEqual([true, false]);
    } finally { for (const release of releases.values()) release.resolve(); await runtime.stop(0); }
  });

  it("reports a real reconnect backlog message but not participant or empty reconnect housekeeping", async () => {
    const platform = BandPlatform.host([person("user")]);
    const joined = await platform.room(room);
    const runtime = new PlatformRuntime({ agentId: AGENT_ID, apiKey: AGENT_API_KEY, linkOptions: platform.link,
      agentConfig: { autoSubscribeExistingRooms: true },
    });
    await runtime.start(new GenericAdapter(async ({ tools }) => { tools.turn.settle(); }));
    try {
      await joined.exchange("user", "initial");
      const reports = platform.rest.workingReports.entries.length;
      await platform.transport.emit(`room_participants:${room}`, "participant_added", { id: "other", name: "Other", type: "User", handle: "other" });
      platform.transport.triggerRejoin(`chat_room:${room}`);
      // This live message is queued after the reconnect sweep and serves as its barrier.
      await joined.exchange("user", "after empty reconnect");
      expect(platform.rest.workingReports.entries.length).toBe(reports + 2);
      const backlog = joined.postBeforeConnect("user", "missed during disconnect");
      platform.transport.triggerRejoin(`chat_room:${room}`);
      await joined.outcome(backlog);
      expect(platform.rest.workingReports.entries.length).toBe(reports + 4);
    } finally { await runtime.stop(0); }
  });

  it("retires reporting on membership loss while an ordinary handler remains held", async () => {
    vi.useFakeTimers();
    const entered = createDeferred();
    const release = createDeferred();
    const cleaned = vi.fn();
    class Adapter extends GenericAdapter {
      public override async onCleanup(roomId: string): Promise<void> { cleaned(roomId); }
    }
    const f = await BandPlatform.join(new Adapter(async ({ tools }) => {
      entered.resolve();
      await release.promise;
      tools.turn.settle();
    }), [person("user")]);
    const reports = vi.spyOn(f.platform.rest, "reportActivity");
    try {
      await f.room.say("user", `@[[${AGENT_ID}]] hold`);
      await entered.promise;
      await f.room.remove();
      await f.room.left();
      await vi.advanceTimersByTimeAsync(12000);
      expect(reports.mock.calls.map((call) => call[1])).toEqual([true, false]);
      expect(cleaned).toHaveBeenCalledExactlyOnceWith(f.room.id);
    } finally {
      release.resolve();
      await f[Symbol.asyncDispose]();
    }
  });

  it("fences suspended admission when membership is lost before the processing mark returns", async () => {
    vi.useFakeTimers();
    const platform = BandPlatform.host([person("user")]);
    const joined = await platform.room(room);
    const cleaned = vi.fn();
    const handled = vi.fn(async ({ tools }) => { tools.turn.settle(); });
    class Adapter extends GenericAdapter {
      public override async onCleanup(roomId: string): Promise<void> { cleaned(roomId); }
    }
    const runtime = new PlatformRuntime({ agentId: AGENT_ID, apiKey: AGENT_API_KEY, linkOptions: platform.link,
      agentConfig: { autoSubscribeExistingRooms: true },
    });
    await runtime.start(new Adapter(handled));
    const processing = joined.holdProcessing("bootstrap");
    const run = runtime.bootstrapRoomMessage(room, { ...message("bootstrap"), senderId: "user" });
    try {
      await processing.sending;
      await joined.remove();
      await joined.left();
      await vi.advanceTimersByTimeAsync(0);
      expect(cleaned).toHaveBeenCalledExactlyOnceWith(room);
      processing.release();
      await run;
      expect(handled).not.toHaveBeenCalled();
      expect(platform.rest.workingReports.entries).toEqual([]);
      expect(platform.rest.posted.entries).toEqual([]);
      expect(joined.outcomes("bootstrap")).toEqual([]);
    } finally {
      processing.release();
      await run;
      await runtime.stop(0);
    }
  });

  it("finishes initial and final timeout budgets without failing adapter execution or delivery", async () => {
    vi.useFakeTimers();
    const log = new RecordLog<string>();
    const rest = new FakeRestApi({ markMessageProcessed: async () => { log.record("processed"); return {}; } }, { id: "a1", name: "Agent", description: null });
    Object.assign(rest, { reportActivity: async (_room: string, working: boolean, options: { abortSignal: AbortSignal }) => {
      log.record(String(working));
      await new Promise((_, reject) => options.abortSignal.addEventListener("abort", () => reject(options.abortSignal.reason), { once: true }));
    } });
    const runtime = new PlatformRuntime({ agentId: "a1", apiKey: "k", link: new BandLink({ agentId: "a1", apiKey: "k", restApi: rest, transport: new FakeTransport() }) });
    await runtime.start(new GenericAdapter(async ({ tools }) => { log.record("adapter"); tools.turn.settle(); }));
    const run = runtime.bootstrapRoomMessage(room, message());
    await log.next((entry) => entry === "true");
    await vi.advanceTimersByTimeAsync(2000);
    await log.next((entry) => entry === "false");
    expect(log.entries).toEqual(["true", "adapter", "false"]);
    await vi.advanceTimersByTimeAsync(2000);
    await run;
    expect(log.entries).toEqual(["true", "adapter", "false", "processed"]);
    await runtime.stop(0);
  });

  it("closes every reporter before disconnect even when one room's adapter cleanup fails", async () => {
    const log = new RecordLog<string>();
    class Transport extends FakeTransport {
      public override async disconnect(): Promise<void> { log.record("disconnect"); await super.disconnect(); }
    }
    const error = new Error("room cleanup failed");
    const providers = [createDeferred(), createDeferred()];
    const retained: Promise<void>[] = [];
    class Adapter extends GenericAdapter {
      public override async onCleanup(roomId: string): Promise<void> { if (roomId === room) throw error; }
    }
    const rest = new FakeRestApi({}, { id: "a1", name: "Agent", description: null });
    Object.assign(rest, { reportActivity: async (roomId: string, working: boolean) => { log.record(`${roomId}:${working}`); return { working }; } });
    const runtime = new PlatformRuntime({ agentId: "a1", apiKey: "k", link: new BandLink({ agentId: "a1", apiKey: "k", restApi: rest, transport: new Transport() }) });
    await runtime.start(new Adapter(async ({ tools }) => { retained.push(retainWorkingCycleUntil(tools, providers[retained.length]!.promise)); tools.turn.settle(); }));
    await runtime.bootstrapRoomMessage(room, message());
    await runtime.bootstrapRoomMessage("room-2", { ...message("other"), roomId: "room-2" });
    const first = runtime.stop(0);
    const second = runtime.stop(0);
    await Promise.all([expect(first).rejects.toBe(error), expect(second).rejects.toBe(error)]);
    expect(log.entries.slice(-3)).toEqual([`${room}:false`, "room-2:false", "disconnect"]);
    for (const provider of providers) provider.resolve();
    await Promise.all(retained);
    expect(log.entries.at(-1)).toBe("disconnect");
  });

  it("closes retained reporting on a fatal loop failure and preserves the original error", async () => {
    const error = new Error("preprocessing failed");
    const base = new DefaultPreprocessor();
    const f = await fixture({ preprocessor: { process: async (context, event, agentId) => {
      if (event.type === "message_created" && event.payload.id === "fatal") throw error;
      return await base.process(context, event, agentId);
    } } });
    const provider = createDeferred();
    let retained: Promise<void> | undefined;
    await f.runtime.start(new GenericAdapter(async ({ tools }) => { retained = retainWorkingCycleUntil(tools, provider.promise); tools.turn.settle(); }));
    await f.runtime.bootstrapRoomMessage(room, message());
    const outcome = expect(f.runtime.runForever()).rejects.toBe(error);
    await f.transport.emit(`chat_room:${room}`, "message_created", {
      id: "fatal", content: "fail", message_type: "text", sender_id: "user", sender_type: "User", sender_name: "User",
      inserted_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    await f.log.next((entry) => entry === "false");
    await outcome;
    await expect(f.runtime.stop(0)).rejects.toBe(error);
    provider.resolve(); await retained;
    expect(f.log.entries.filter((entry) => entry === "false")).toHaveLength(1);
  });

  it("stops with the original error when a fatal failure is still closing reporting", async () => {
    const error = new Error("preprocessing failed");
    const base = new DefaultPreprocessor();
    const closing = createDeferred();
    const closed = createDeferred();
    const f = await fixture({
      preprocessor: { process: async (context, event, agentId) => {
        if (event.type === "message_created" && event.payload.id === "fatal") throw error;
        return await base.process(context, event, agentId);
      } },
      report: async (working) => { if (!working) { closing.resolve(); await closed.promise; } },
    });
    const provider = createDeferred();
    let retained: Promise<void> | undefined;
    await f.runtime.start(new GenericAdapter(async ({ tools }) => { retained = retainWorkingCycleUntil(tools, provider.promise); tools.turn.settle(); }));
    await f.runtime.bootstrapRoomMessage(room, message());
    const outcome = expect(f.runtime.runForever()).rejects.toBe(error);
    await f.transport.emit(`chat_room:${room}`, "message_created", {
      id: "fatal", content: "fail", message_type: "text", sender_id: "user", sender_type: "User", sender_name: "User",
      inserted_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    await closing.promise;
    const stopping = f.runtime.stop(0);
    closed.resolve();
    await expect(stopping).rejects.toBe(error);
    await outcome;
    provider.resolve(); await retained;
  });

  it("stops scanning the backlog once a forced stop has closed the queue, while reporting still closes", async () => {
    const firstRead = createDeferred<unknown>();
    const rescanned = createDeferred();
    const closing = createDeferred();
    const closed = createDeferred();
    const entered = createDeferred();
    const release = createDeferred();
    let reads = 0;
    const link = {
      getNextMessage: async () => {
        if (++reads > 1) rescanned.resolve();
        return await firstRead.promise;
      },
      getStaleProcessingMessages: async () => [],
      markFailed: async () => {},
    };
    const context = new ExecutionContext({ roomId: room, link: link as never, maxContextMessages: 20 });
    const report = async (working: boolean) => { if (!working) { closing.resolve(); await closed.promise; } };
    const execution = new Execution({ roomId: room, link: link as never, context, onExecute: async (handlerContext, event, admitted) => {
      // As PlatformRuntime does: an unadmitted backlog head is left unmarked, so `/messages/next` serves it again.
      if (!admitted() || event.type !== "message_created" || event.payload.id !== "bootstrap") return;
      handlerContext.openWorkingCycle(report);
      entered.resolve();
      await release.promise;
    } });
    const bootstrapping = execution.bootstrapMessage(message("bootstrap") as never);
    await entered.promise;

    const stopping = execution.stop(0);
    await closing.promise;
    firstRead.resolve(message("backlog"));
    release.resolve(); await bootstrapping;
    const outcome = await Promise.race([rescanned.promise.then(() => "rescanned"), execution.waitForIdle().then(() => "idle")]);
    closed.resolve(); await stopping;
    expect(outcome).toBe("idle");
  });

  it("disabled reporting still admits handlers and preserves deliberate no-reply tools", async () => {
    const config = { enableWorkingState: false, workingKeepAliveSeconds: 0, workingRequestTimeoutSeconds: -1, maxWorkingStateSeconds: -1 };
    const f = await fixture({ sessionConfig: config });
    const handler = vi.fn(async ({ tools }) => { await tools.executeToolCall("band_no_reply", {}); });
    await f.runtime.start(new GenericAdapter(handler));
    await f.runtime.bootstrapRoomMessage(room, message());
    expect(handler).toHaveBeenCalledTimes(1);
    expect(f.log.entries).toEqual(["processing", "processed"]);
    await f.runtime.stop(0);
  });
});
