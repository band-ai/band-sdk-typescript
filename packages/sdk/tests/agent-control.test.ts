import type { Agent as AcpAgent } from "@agentclientprotocol/sdk";
import { agentContactsTopic } from "@band-ai/band-sdk-core";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { ACPClientAdapter } from "../src/adapters/acp";
import { GenericAdapter, type GenericAdapterHandler } from "../src/adapters/GenericAdapter";
import { Agent } from "../src/agent/Agent";
import type { AgentEvent } from "../src/contracts/events";
import type { FrameworkAdapter } from "../src/contracts/protocols";
import { BandLink } from "../src/platform/BandLink";
import type { ContactEventConfig, SessionConfig } from "../src/runtime/types";
import { MS_PER_SECOND } from "../src/core/deadline";
import { createDeferred } from "../src/core/deferred";
import { RuntimeStateError } from "../src/core/errors";
import { AGENT_API_KEY, AGENT_ID, BandPlatform, person } from "./flows/support/bandPlatform";
import { inMemoryAgent } from "./support/inMemoryAcpAgent";
import { RecordLog, tmpRoot } from "./testUtils";

const ROOM_A = "room-a";
const ROOM_B = "room-b";

/**
 * A handler whose first turn works until `release`, as one cut short while it
 * works and that cannot be cancelled; later turns settle at once. `ended`
 * records each turn as it returns.
 */
function firstTurnHangs() {
  const handled = new RecordLog<{ roomId: string; messageId: string }>();
  const ended = new RecordLog<string>();
  const released = createDeferred();
  onTestFinished(() => released.resolve());
  const handler: GenericAdapterHandler = async ({ roomId, message, tools }) => {
    handled.record({ roomId, messageId: message.id });
    if (handled.entries.length === 1) {
      await released.promise;
    }
    tools.turn.settle();
    ended.record(message.id);
  };
  return { adapter: new GenericAdapter(handler), handled, ended, release: released.resolve };
}

/** A handler that settles every turn at once, recording it. */
function settlingAdapter() {
  const handled = new RecordLog<{ roomId: string; messageId: string }>();
  const adapter = new GenericAdapter(async ({ roomId, message, tools }) => {
    handled.record({ roomId, messageId: message.id });
    tools.turn.settle();
  });
  return { adapter, handled };
}

/** An agent on `platform`, not yet started, recording what it reports and stopped when the test ends. */
function createAgent(platform: BandPlatform, adapter: FrameworkAdapter, options: { sessionConfig?: SessionConfig; contactConfig?: ContactEventConfig } = {}) {
  const agent = Agent.create({
    adapter,
    agentId: AGENT_ID,
    apiKey: AGENT_API_KEY,
    link: new BandLink({ agentId: AGENT_ID, apiKey: AGENT_API_KEY, ...platform.link }),
    ...options,
  });
  const events = new RecordLog<AgentEvent>();
  agent.observe((event) => {
    events.record(event);
  });
  onTestFinished(async () => {
    if (agent.isRunning) await agent.stop();
  });
  return { agent, events };
}

/** A started agent on a platform that has it in rooms A and B. */
async function startAgent(adapter: FrameworkAdapter, sessionConfig?: SessionConfig, contactConfig?: ContactEventConfig) {
  const platform = BandPlatform.host([person("owner")]);
  const roomA = await platform.room(ROOM_A);
  const roomB = await platform.room(ROOM_B);
  const { agent, events } = createAgent(platform, adapter, { sessionConfig, contactConfig });
  await agent.start();
  /** Resolves with the next event at or after `from` that matches. */
  const next = (matches: (event: AgentEvent) => boolean, from = 0) => events.next(matches, from);
  const of = (roomId: string) =>
    events.entries.filter((event) => "roomId" in event && event.roomId === roomId).map((event) => event.type);
  return { agent, platform, roomA, roomB, events, next, of };
}

const is = <T extends AgentEvent["type"]>(type: T, roomId: string) =>
  (event: AgentEvent): event is Extract<AgentEvent, { type: T }> => event.type === type && "roomId" in event && event.roomId === roomId;

/** A stopped room's check interval, and the keep-alive cadence, for the fake-clock tests. */
const RESYNC_SECONDS = 30;
const RESYNC_MS = RESYNC_SECONDS * MS_PER_SECOND;
const KEEP_ALIVE_SECONDS = 3;

/** Fakes timeouts for this test only; the in-process platform answers on microtasks, which stay real. */
function useFakeTimeouts(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

/** A contact request as Band pushes it on the agent's contacts channel. */
const contactRequest = (id: string, from: string) => ({
  id, from_handle: from, from_name: from, message: "Hello", status: "pending", inserted_at: new Date().toISOString(),
});

describe("agent.control from Band", () => {
  it("stops a room's running turn, leaves its message for Band, and replays it on play once the cut-short turn ends", async () => {
    const { adapter, handled, ended, release } = firstTurnHangs();
    const { platform, roomA, next, of } = await startAgent(adapter);
    const first = await roomA.say("owner", "first");
    await handled.until(() => handled.entries.length === 1);

    platform.control("stop", ROOM_A);
    await next(is("turn.stopped", ROOM_A));
    // Neither settled nor run while stopped: Band keeps both for the room.
    const second = await roomA.say("owner", "second");
    expect(roomA.outcomes(first)).toEqual([]);

    // The adapter could not cancel the cut-short turn, so the replay's catch-up waits for it.
    const catchUp = platform.rest.nextMessageHolds.hold((roomId) => roomId === ROOM_A);
    const endedWhenCaughtUp = catchUp.sending.then(() => [...ended.entries]);
    platform.control("play", ROOM_A);
    await next(is("room.resumed", ROOM_A));
    release();
    expect(await endedWhenCaughtUp).toEqual([first]);
    catchUp.release();

    expect(await roomA.outcome(first)).toBe("processed");
    expect(await roomA.outcome(second)).toBe("processed");
    expect(handled.entries.map((turn) => turn.messageId)).toEqual([first, first, second]);
    expect(ended.entries).toEqual([first, first, second]);
    expect(of(ROOM_A)).toEqual([
      "room.joined",
      "turn.started", "room.paused", "turn.stopped",
      "room.resumed",
      "turn.started", "turn.completed", "turn.started", "turn.completed",
    ]);
  });

  it("interrupts a room's running turn and consumes its message, leaving the room running", async () => {
    const { adapter, handled, release } = firstTurnHangs();
    const { platform, roomA, next } = await startAgent(adapter);
    const first = await roomA.say("owner", "first");
    await handled.until(() => handled.entries.length === 1);

    platform.control("interrupt", ROOM_A);

    expect(await roomA.outcome(first)).toBe("processed");
    expect(await next(is("turn.stopped", ROOM_A))).toMatchObject({ messageId: first, mode: "interrupt" });
    release();
    expect((await roomA.sayAndSettle("owner", "second")).outcome).toBe("processed");
    expect(handled.entries).toHaveLength(2);
  });

  it("stops and plays every room for an agent-wide signal, and only the named room for a room signal", async () => {
    const { adapter, handled, release } = firstTurnHangs();
    const { platform, roomA, roomB, next, of } = await startAgent(adapter);
    // Uses up the handler's one hanging turn, so later turns settle.
    await roomA.say("owner", "warm-up");
    await handled.until(() => handled.entries.length === 1);
    platform.control("interrupt", ROOM_A);
    await next(is("turn.stopped", ROOM_A));
    release();

    platform.control("stop", null);
    await next(is("room.paused", ROOM_B));
    const held = await roomB.say("owner", "held");
    platform.control("play", ROOM_A);
    await next(is("room.resumed", ROOM_A));

    expect((await roomA.sayAndSettle("owner", "runs")).outcome).toBe("processed");
    expect(roomB.outcomes(held)).toEqual([]);
    // The room-scoped play reached A only: the runtime still holds B paused.
    expect(of(ROOM_B).filter((type) => type === "room.paused" || type === "room.resumed")).toEqual(["room.paused"]);
    platform.control("play", null);
    expect(await roomB.outcome(held)).toBe("processed");
  });

  it("applies a repeated signal once", async () => {
    const { adapter } = settlingAdapter();
    const { platform, events, next } = await startAgent(adapter);
    const stop = platform.control("stop", ROOM_A);
    await next(is("room.paused", ROOM_A));
    const played = events.entries.length;
    platform.control("play", ROOM_A);
    await next(is("room.resumed", ROOM_A), played);

    // Band repeats the old stop; signals apply in order, so once B's later stop
    // applied, the repeat was handled, and the room stays resumed.
    platform.control("stop", ROOM_A, { correlationId: stop });
    platform.control("stop", ROOM_B);
    await next(is("room.paused", ROOM_B), played);
    expect(events.entries.slice(played).filter(is("room.paused", ROOM_A))).toEqual([]);
  });

  it("resumes a stopped room whose play it missed once a reconnect finds Band serving it again", async () => {
    const { adapter, handled } = settlingAdapter();
    const { platform, roomA, next } = await startAgent(adapter);
    platform.control("stop", ROOM_A);
    await next(is("room.paused", ROOM_A));
    const waiting = await roomA.say("owner", "while stopped");
    platform.control("play", ROOM_A, { delivered: false });

    await platform.transport.triggerReconnect({ generation: 1, joinedTopics: new Set(platform.transport.bound.entries) });

    await next(is("room.resumed", ROOM_A));
    expect(await roomA.outcome(waiting)).toBe("processed");
    expect(handled.entries.map((turn) => turn.messageId)).toEqual([waiting]);
  });

  it("stays stopped across a reconnect while Band still holds the room", async () => {
    const { adapter, handled } = settlingAdapter();
    const { platform, roomA, of, next } = await startAgent(adapter);
    platform.control("stop", ROOM_A);
    await next(is("room.paused", ROOM_A));
    const waiting = await roomA.say("owner", "while stopped");
    const reconnect = (generation: number) =>
      platform.transport.triggerReconnect({ generation, joinedTopics: new Set(platform.transport.bound.entries) });

    await reconnect(1);
    // The room handles one catch-up at a time, so once the second reconnect's
    // probe reaches Band, the first catch-up has run.
    const secondProbe = platform.rest.nextMessageHolds.hold((roomId) => roomId === ROOM_A);
    await reconnect(2);
    await secondProbe.sending;
    secondProbe.release();

    expect(of(ROOM_A)).not.toContain("room.resumed");
    expect(roomA.outcomes(waiting)).toEqual([]);
    expect(handled.entries).toEqual([]);
  });

  it("asks an ACP agent to cancel the prompt a stop cut short", async () => {
    const cancelRequested = createDeferred();
    const promptStarted = createDeferred();
    const adapter = new ACPClientAdapter({
      command: ["acp-fixture"],
      cwd: tmpRoot(),
      enableMcpTools: false,
      connectionFactory: inMemoryAgent((): AcpAgent => {
        let cancel!: () => void;
        return {
          initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }),
          authenticate: async () => ({}),
          newSession: async () => ({ sessionId: "session-1" }),
          cancel: async () => {
            cancelRequested.resolve();
            cancel();
          },
          prompt: async () => {
            const ended = new Promise<void>((resolve) => {
              cancel = resolve;
            });
            promptStarted.resolve();
            await ended;
            return { stopReason: "cancelled" };
          },
        };
      }),
    });
    const { platform, roomA, next } = await startAgent(adapter);
    const first = await roomA.say("owner", "first");
    await promptStarted.promise;

    platform.control("stop", ROOM_A);

    expect(await next(is("turn.stopped", ROOM_A))).toMatchObject({ messageId: first, mode: "stop" });
    await cancelRequested.promise;
    expect(roomA.outcomes(first)).toEqual([]);
  });

  it("stops a backlog turn the start-up catch-up is running, and replays it on play", async () => {
    const { adapter, handled, release } = firstTurnHangs();
    const platform = BandPlatform.host([person("owner")]);
    const roomA = await platform.room(ROOM_A);
    const missed = roomA.postBeforeConnect("owner", "sent while the agent was away");
    const { agent, events } = createAgent(platform, adapter);
    await agent.start();
    await handled.until(() => handled.entries.length === 1);

    platform.control("stop", ROOM_A);
    expect(await events.next(is("turn.stopped", ROOM_A))).toMatchObject({ messageId: missed, mode: "stop" });
    release();
    platform.control("play", ROOM_A);

    expect(await roomA.outcome(missed)).toBe("processed");
    expect(handled.entries.map((turn) => turn.messageId)).toEqual([missed, missed]);
  });

  it("keeps a room stopped across a reset of its session", async () => {
    const { adapter, handled } = settlingAdapter();
    const { agent, platform, roomA, next, of } = await startAgent(adapter);
    platform.control("stop", ROOM_A);
    await next(is("room.paused", ROOM_A));

    await agent.resetRoomSession(ROOM_A);
    const waiting = await roomA.say("owner", "after the reset");
    expect(of(ROOM_A)).toEqual(["room.joined", "room.paused", "room.stopped", "room.joined"]);
    platform.control("play", ROOM_A);

    expect(await roomA.outcome(waiting)).toBe("processed");
    expect(handled.entries.map((turn) => turn.messageId)).toEqual([waiting]);
  });

  it("pauses a room Band stopped without its push once Band refuses the turn's claim, and replays it on play", async () => {
    const { adapter, handled } = settlingAdapter();
    const { platform, roomA, next, of } = await startAgent(adapter);
    platform.control("stop", ROOM_A, { delivered: false });

    const waiting = await roomA.say("owner", "after the missed stop");

    await next(is("room.paused", ROOM_A));
    expect(handled.entries).toEqual([]);
    expect(roomA.outcomes(waiting)).toEqual([]);
    platform.control("play", ROOM_A);
    expect(await roomA.outcome(waiting)).toBe("processed");
    expect(of(ROOM_A)).toEqual(["room.joined", "room.paused", "room.resumed", "turn.started", "turn.completed"]);
  });

  it("cuts a turn short when Band refuses its post as stopped, without the stop's push", async () => {
    const gate = createDeferred();
    onTestFinished(() => gate.resolve());
    const posts = new RecordLog<string>();
    const adapter = new GenericAdapter(async ({ message, tools }) => {
      posts.record(message.id);
      if (posts.entries.length === 1) await gate.promise;
      await tools.sendMessage("done", ["owner"]);
    });
    const { platform, roomA, next } = await startAgent(adapter);
    const first = await roomA.say("owner", "first");
    await posts.until(() => posts.entries.length === 1);

    platform.control("stop", ROOM_A, { delivered: false });
    gate.resolve();

    expect(await next(is("turn.stopped", ROOM_A))).toMatchObject({ messageId: first, mode: "stop" });
    expect(roomA.messages).toEqual([]);
    platform.control("play", ROOM_A);
    expect(await roomA.outcome(first)).toBe("processed");
    expect(roomA.messages.map((posted) => posted.content)).toEqual(["done"]);
  });

  it("does not run a stopped room's leftover message on restart, and runs it on play", async () => {
    const { adapter, handled } = settlingAdapter();
    const platform = BandPlatform.host([person("owner")]);
    const roomA = await platform.room(ROOM_A);
    // A turn a stop cut short in an earlier run: claimed, never settled, and the room still stopped.
    const leftover = roomA.postBeforeConnect("owner", "cut short before the restart");
    await platform.rest.markMessageProcessing(ROOM_A, leftover);
    platform.rest.serveStaleProcessing = true;
    platform.control("stop", ROOM_A, { delivered: false });
    const { agent, events } = createAgent(platform, adapter);

    await agent.start();

    await events.next(is("room.paused", ROOM_A));
    expect(handled.entries).toEqual([]);
    platform.control("play", ROOM_A);
    expect(await roomA.outcome(leftover)).toBe("processed");
    expect(handled.entries.map((turn) => turn.messageId)).toEqual([leftover]);
  });

  it("finds a missed play by checking a stopped room on its interval", async () => {
    const { adapter, handled } = settlingAdapter();
    useFakeTimeouts();
    const { platform, roomA, next } = await startAgent(adapter, { stoppedResyncSeconds: RESYNC_SECONDS });
    platform.control("stop", ROOM_A);
    await next(is("room.paused", ROOM_A));
    const waiting = await roomA.say("owner", "while stopped");
    platform.control("play", ROOM_A, { delivered: false });

    await vi.advanceTimersByTimeAsync(RESYNC_MS - 1);
    expect(handled.entries).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    await next(is("room.resumed", ROOM_A));
    vi.useRealTimers();
    expect(await roomA.outcome(waiting)).toBe("processed");
  });

  it("treats a working report Band echoes as not working as the room being stopped", async () => {
    const platform = BandPlatform.host([person("owner")]);
    await platform.room(ROOM_A);
    const link = new BandLink({ agentId: AGENT_ID, apiKey: AGENT_API_KEY, ...platform.link });
    const stopped = new RecordLog<string>();
    link.onExecutionStopped((roomId) => stopped.record(roomId));

    await link.reportActivity(ROOM_A, true);
    await link.reportActivity(ROOM_A, false);
    platform.control("stop", ROOM_A, { delivered: false });
    await link.reportActivity(ROOM_A, false);
    await link.reportActivity(ROOM_A, true);

    expect(stopped.entries).toEqual([ROOM_A]);
  });

  it("cuts a long turn short when its keep-alive report is echoed as not working, the only sign of a missed stop for a turn that writes nothing", async () => {
    const { adapter, handled, release } = firstTurnHangs();
    useFakeTimeouts();
    const { platform, roomA, next } = await startAgent(adapter, { workingKeepAliveSeconds: KEEP_ALIVE_SECONDS });
    const first = await roomA.say("owner", "first");
    await handled.until(() => handled.entries.length === 1);

    platform.control("stop", ROOM_A, { delivered: false });
    // The turn's next keep-alive is the first report Band answers as not working.
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_SECONDS * MS_PER_SECOND);
    expect(await next(is("turn.stopped", ROOM_A))).toMatchObject({ messageId: first, mode: "stop" });
    vi.useRealTimers();
    expect(roomA.outcomes(first)).toEqual([]);
    release();
    platform.control("play", ROOM_A);

    expect(await roomA.outcome(first)).toBe("processed");
    expect(handled.entries.map((turn) => turn.messageId)).toEqual([first, first]);
  });

  it("refuses the tools of an interrupted turn the adapter could not cancel, so its late reply never posts", async () => {
    const released = createDeferred();
    onTestFinished(() => released.resolve());
    const outcomes = new RecordLog<string>();
    const adapter = new GenericAdapter(async ({ message, tools }) => {
      if (outcomes.entries.length === 0) {
        outcomes.record("started");
        await released.promise;
        await tools.sendMessage("late reply", ["owner"]).then(
          () => outcomes.record("posted"),
          () => outcomes.record("refused"),
        );
        return;
      }
      await tools.sendMessage(`reply to ${message.content}`, ["owner"]);
    });
    const { platform, roomA, next } = await startAgent(adapter);
    const first = await roomA.say("owner", "first");
    await outcomes.until(() => outcomes.entries.length === 1);

    platform.control("interrupt", ROOM_A);
    await next(is("turn.stopped", ROOM_A));
    released.resolve();
    await outcomes.until(() => outcomes.entries.length === 2);

    expect(outcomes.entries).toEqual(["started", "refused"]);
    expect(await roomA.outcome(first)).toBe("processed");
    expect((await roomA.sayAndSettle("owner", "second")).outcome).toBe("processed");
    expect(roomA.messages.map((posted) => posted.content)).toEqual(["reply to second"]);
  });

  it("finds a missed play as soon as Band delivers the room a message", async () => {
    const { adapter } = settlingAdapter();
    const { platform, roomA, next } = await startAgent(adapter);
    platform.control("stop", ROOM_A);
    await next(is("room.paused", ROOM_A));
    platform.control("play", ROOM_A, { delivered: false });

    // No reconnect, and the periodic check is a minute away: the message itself prompts the check.
    const waiting = await roomA.say("owner", "after the missed play");

    await next(is("room.resumed", ROOM_A));
    expect(await roomA.outcome(waiting)).toBe("processed");
  });

  it("replays the stopped turn's message before anything queued behind it", async () => {
    const { adapter, handled, release } = firstTurnHangs();
    const { platform, roomA, next } = await startAgent(adapter);
    const first = await roomA.say("owner", "first");
    await handled.until(() => handled.entries.length === 1);
    const second = await roomA.say("owner", "second");

    platform.control("stop", ROOM_A);
    await next(is("turn.stopped", ROOM_A));
    platform.control("play", ROOM_A);
    await next(is("room.resumed", ROOM_A));
    release();

    expect(await roomA.outcome(second)).toBe("processed");
    expect(await roomA.outcome(first)).toBe("processed");
    expect(handled.entries.map((turn) => turn.messageId)).toEqual([first, first, second]);
  });

  it("stops gracefully after a play its room was stopped again before it caught up", async () => {
    const { adapter, handled, ended, release } = firstTurnHangs();
    const { agent, platform, roomA, next, events } = await startAgent(adapter);
    await roomA.say("owner", "first");
    await handled.until(() => handled.entries.length === 1);
    platform.control("stop", ROOM_A);
    await next(is("turn.stopped", ROOM_A));
    const mark = events.entries.length;
    platform.control("play", ROOM_A);
    await next(is("room.resumed", ROOM_A), mark);
    platform.control("stop", ROOM_A);
    await next(is("room.paused", ROOM_A), mark);
    release();
    await ended.until(() => ended.entries.length === 1);

    // A zero budget reports graceful only if every room is idle now.
    await expect(agent.stop(0)).resolves.toBe(true);
  });

  it.each(["stop", "interrupt"] as const)("settles a turn %s cut short while it was being prepared, and gives back what preparing it took", async (mode) => {
    const bootstraps = new RecordLog<{ messageId: string; isSessionBootstrap: boolean }>();
    const adapter = new GenericAdapter(async ({ message, isSessionBootstrap, tools }) => {
      bootstraps.record({ messageId: message.id, isSessionBootstrap });
      tools.turn.settle();
    });
    const { platform, roomA, next } = await startAgent(adapter);
    // A session's first turn hydrates its history before the adapter sees it.
    const hydration = platform.rest.contextHolds.hold((roomId) => roomId === ROOM_A);
    const first = await roomA.say("owner", "first");
    await hydration.sending;

    platform.control(mode, ROOM_A);
    // Signals apply in order, so once B's later stop applied, A's signal has too.
    platform.control("stop", ROOM_B);
    await next(is("room.paused", ROOM_B));
    hydration.release();
    if (mode === "stop") {
      platform.control("play", ROOM_A);
    }

    expect(await roomA.outcome(first)).toBe("processed");
    const second = await roomA.say("owner", "second");
    expect(await roomA.outcome(second)).toBe("processed");
    // A stopped message runs again, as the session's first turn; an interrupted one is consumed unrun.
    expect(bootstraps.entries).toEqual(mode === "stop"
      ? [{ messageId: first, isSessionBootstrap: true }, { messageId: second, isSessionBootstrap: false }]
      : [{ messageId: second, isSessionBootstrap: true }]);
  });

  it("ends Band's pause when the agent loses the room, so a rejoined room runs without a play", async () => {
    const { adapter, handled } = settlingAdapter();
    const { platform, roomA, next, of, events } = await startAgent(adapter);
    platform.control("stop", ROOM_A);
    await next(is("room.paused", ROOM_A));
    await roomA.remove();
    await next(is("room.left", ROOM_A));
    // Band's stop went with the membership.
    platform.rest.stoppedRooms.delete(ROOM_A);
    const mark = events.entries.length;

    await platform.room(ROOM_A);
    await next(is("room.joined", ROOM_A), mark);
    const after = await roomA.say("owner", "after rejoining");

    expect(await roomA.outcome(after)).toBe("processed");
    expect(handled.entries.map((turn) => turn.messageId)).toEqual([after]);
    expect(of(ROOM_A).filter((type) => type === "room.paused" || type === "room.resumed")).toEqual(["room.paused", "room.resumed"]);
  });

  it("does not remember a signal that reached no handled room, so its repeat applies once the room is", async () => {
    const { adapter } = settlingAdapter();
    const { platform, next } = await startAgent(adapter);
    const stop = platform.control("stop", "room-c");

    await platform.room("room-c");
    await next(is("room.joined", "room-c"));
    platform.control("stop", "room-c", { correlationId: stop });

    await next(is("room.paused", "room-c"));
  });

  it("runs again a contact hub turn a stop cut short once the room is played, since Band holds no copy of it", async () => {
    const { adapter, handled, ended, release } = firstTurnHangs();
    const { platform, next } = await startAgent(adapter, undefined, { strategy: "hub_room", hubTaskId: "contacts" });
    await platform.transport.emit(agentContactsTopic(AGENT_ID), "contact_request_received", contactRequest("request-1", "alice"));
    const started = await next((event) => event.type === "turn.started");
    if (started.type !== "turn.started") throw new Error("expected the hub turn to start");
    const { roomId: hub, messageId } = started;

    platform.control("stop", hub);
    await next(is("turn.stopped", hub));
    release();
    await ended.until(() => ended.entries.length === 1);
    platform.control("play", hub);

    await ended.until(() => ended.entries.length === 2);
    expect(handled.entries).toEqual([{ roomId: hub, messageId }, { roomId: hub, messageId }]);
  });

  it("applies an agent-wide stop to every room at once, and later signals, while the adapter's cancel never settles", async () => {
    const settling = settlingAdapter();
    const { handled } = settling;
    const cancels = new RecordLog<string>();
    const adapter = Object.assign(settling.adapter, {
      // A cancel stuck on a wedged backend.
      cancelTurn: async (roomId: string): Promise<boolean> => {
        cancels.record(roomId);
        return await new Promise<boolean>(() => undefined);
      },
    });
    const { platform, roomA, roomB, next, of } = await startAgent(adapter);

    platform.control("stop", null);
    await next(is("room.paused", ROOM_B));
    await roomB.remove();
    await next(is("room.left", ROOM_B));
    platform.control("play", ROOM_A);
    await next(is("room.resumed", ROOM_A));

    expect((await roomA.sayAndSettle("owner", "after the play")).outcome).toBe("processed");
    expect(handled.entries.map((turn) => turn.roomId)).toEqual([ROOM_A]);
    await cancels.until(() => cancels.entries.length === 2);
    expect(cancels.entries).toEqual([ROOM_A, ROOM_B]);
    // Band's pause went with the membership, and nothing paused the room after it was left.
    expect(of(ROOM_B)).toEqual(["room.joined", "room.paused", "room.stopped", "room.resumed", "room.left"]);
  });

  it("keeps checking a stopped room after a check fails, and finds the missed play on the next one", async () => {
    const { adapter } = settlingAdapter();
    useFakeTimeouts();
    const { platform, roomA, next } = await startAgent(adapter, { stoppedResyncSeconds: RESYNC_SECONDS });
    platform.control("stop", ROOM_A);
    await next(is("room.paused", ROOM_A));
    // The check the delivered message starts, while Band still has the room stopped.
    const deliveredCheck = platform.rest.nextMessageHolds.hold((roomId) => roomId === ROOM_A);
    const waiting = await roomA.say("owner", "while stopped");
    await deliveredCheck.sending;
    deliveredCheck.release();
    platform.control("play", ROOM_A, { delivered: false });
    const failedCheck = platform.rest.nextMessageHolds.hold((roomId) => roomId === ROOM_A, { error: new Error("Band unavailable") });

    await vi.advanceTimersByTimeAsync(RESYNC_MS);
    await failedCheck.sending;
    failedCheck.release();
    await vi.advanceTimersByTimeAsync(RESYNC_MS);

    await next(is("room.resumed", ROOM_A));
    vi.useRealTimers();
    expect(await roomA.outcome(waiting)).toBe("processed");
  });

  it.each(["stop", "interrupt"] as const)("reports a turn %s cut short as stopped, not failed, when it fails after the runtime stopped waiting on it", async (mode) => {
    const handled = new RecordLog<string>();
    const failed = new RecordLog<string>();
    const released = createDeferred();
    onTestFinished(() => released.resolve());
    const adapter = new GenericAdapter(async ({ message, tools }) => {
      handled.record(message.id);
      if (handled.entries.length === 1) {
        await released.promise;
        failed.record(message.id);
        throw new Error("provider failed after the stop");
      }
      tools.turn.settle();
    });
    const { platform, roomA, next, of } = await startAgent(adapter);
    const first = await roomA.say("owner", "first");
    await handled.until(() => handled.entries.length === 1);

    platform.control(mode, ROOM_A);
    await next(is("turn.stopped", ROOM_A));
    released.resolve();
    await failed.until(() => failed.entries.length === 1);
    if (mode === "stop") {
      platform.control("play", ROOM_A);
    }

    // Interrupted, it is consumed; stopped, it runs again once played.
    expect(await roomA.outcome(first)).toBe("processed");
    expect(handled.entries).toEqual(mode === "stop" ? [first, first] : [first]);
    expect(of(ROOM_A)).not.toContain("turn.failed");
  });

  it("settles a message it gave up on once Band plays the room that refused the give-up, and runs what Band kept meanwhile", async () => {
    const platform = BandPlatform.host([person("owner")]);
    const roomA = await platform.room(ROOM_A);
    const handled = new RecordLog<string>();
    const adapter = new GenericAdapter(async ({ message, tools }) => {
      handled.record(message.id);
      if (handled.entries.length === 1) throw new Error("provider down");
      tools.turn.settle();
    });
    // A backlog message the start-up catch-up runs; it fails, and Band keeps serving it.
    const failing = roomA.postBeforeConnect("owner", "fails");
    const served = platform.rest.nextMessageHolds.hold((roomId) => roomId === ROOM_A);
    const { agent, events } = createAgent(platform, adapter);
    const starting = agent.start();
    await served.sending;
    served.release();
    // The catch-up's next read serves the failed message again, to be given up on.
    const servedAgain = platform.rest.nextMessageHolds.hold((roomId) => roomId === ROOM_A);
    await servedAgain.sending;
    // Band stops the room just then, and its push is missed: the give-up's claim is refused.
    platform.control("stop", ROOM_A, { delivered: false });
    servedAgain.release();
    await starting;
    await events.next(is("room.paused", ROOM_A));
    const kept = await roomA.say("owner", "while stopped");

    platform.control("play", ROOM_A);

    expect(await roomA.outcome(kept)).toBe("processed");
    expect(roomA.outcomes(failing)).toEqual(["failed", "processed"]);
    expect(handled.entries).toEqual([failing, kept]);
  });

  it("runs a reset room's next message at once when Band played it during the reset", async () => {
    const { adapter, handled } = settlingAdapter();
    const { agent, platform, roomA, next, of } = await startAgent(adapter);
    platform.control("stop", ROOM_A);
    await agent.resetRoomSession(ROOM_A);
    await next(is("room.stopped", ROOM_A));
    // No execution takes this play; Band's stop stays recorded for the room.
    platform.control("play", ROOM_A);

    // As the Linear bridge hands a reset room its next message: the room's new
    // execution starts paused, checks /next at once and finds the play.
    const id = roomA.postBeforeConnect("owner", "after the play");
    await agent.bootstrapRoomMessage(ROOM_A, {
      id, roomId: ROOM_A, content: "after the play", senderId: "owner", senderType: "User", senderName: "owner",
      messageType: "text", metadata: {}, createdAt: new Date(),
    });
    expect(handled.entries.map((turn) => turn.messageId)).toEqual([id]);
    expect(of(ROOM_A)).toEqual(["room.joined", "room.paused", "room.stopped", "room.joined", "room.resumed", "turn.started", "turn.completed"]);
  });

  it("replies once to a turn whose processed mark Band refused as stopped, settling it on play", async () => {
    const replying = new GenericAdapter(async ({ message, tools }) => {
      await tools.sendMessage(`reply to ${message.content}`, ["owner"]);
    });
    const { platform, roomA, next } = await startAgent(replying);
    const held = roomA.holdNextProcessed();
    const first = await roomA.say("owner", "first");
    await held.sending;
    // The stop's push is missed: Band refuses the processed mark instead.
    platform.control("stop", ROOM_A, { delivered: false });
    held.release();
    await next(is("room.paused", ROOM_A));

    platform.control("play", ROOM_A);

    expect(await roomA.outcome(first)).toBe("processed");
    expect((await roomA.sayAndSettle("owner", "after")).outcome).toBe("processed");
    expect(roomA.messages.map((posted) => posted.content)).toEqual(["reply to first", "reply to after"]);
  });

  it("rejects, not throws, a call a cut-short turn makes to a revoked tool, and still describes its tools", async () => {
    const outcomes = new RecordLog<string>();
    const released = createDeferred();
    onTestFinished(() => released.resolve());
    // A plain adapter, with no SimpleAdapter wrapping its tools.
    const adapter: FrameworkAdapter = {
      onStarted: async () => undefined,
      onCleanup: async () => undefined,
      onEvent: async ({ tools }) => {
        await released.promise;
        outcomes.record(`schemas: ${tools.getOpenAIToolSchemas().length > 0}`);
        await tools.sendNotice("late notice").then(
          () => outcomes.record("posted"),
          (error: unknown) => outcomes.record(error instanceof RuntimeStateError ? "rejected" : "failed"),
        );
      },
    };
    const { platform, roomA, next } = await startAgent(adapter);
    await roomA.say("owner", "first");
    await next(is("turn.started", ROOM_A));
    platform.control("interrupt", ROOM_A);
    await next(is("turn.stopped", ROOM_A));
    released.resolve();

    await outcomes.until(() => outcomes.entries.length === 2);
    expect(outcomes.entries).toEqual(["schemas: true", "rejected"]);
    expect(roomA.messages).toEqual([]);
  });

  it("catches a room up on play even when this run never saw Band stop it", async () => {
    const { adapter, handled } = settlingAdapter();
    const platform = BandPlatform.host([person("owner")]);
    const roomA = await platform.room(ROOM_A);
    // An earlier run saw the stop; Band kept what arrived meanwhile.
    platform.control("stop", ROOM_A, { delivered: false });
    const kept = roomA.postBeforeConnect("owner", "sent while the room was stopped");
    const { agent } = createAgent(platform, adapter);
    await agent.start();
    expect(handled.entries).toEqual([]);

    platform.control("play", ROOM_A);

    expect(await roomA.outcome(kept)).toBe("processed");
    expect(handled.entries.map((turn) => turn.messageId)).toEqual([kept]);
  });

  it("catches a reset room up on what Band kept once its next message arrives after a play, whether or not this run saw the stop", async () => {
    const { adapter, handled } = settlingAdapter();
    const platform = BandPlatform.host([person("owner")]);
    const roomA = await platform.room(ROOM_A);
    const roomB = await platform.room(ROOM_B);
    // B's stop came before this run; A's is seen.
    platform.control("stop", ROOM_B, { delivered: false });
    const keptB = roomB.postBeforeConnect("owner", "kept in B");
    const { agent, events } = createAgent(platform, adapter);
    await agent.start();
    platform.control("stop", ROOM_A);
    await events.next(is("room.paused", ROOM_A));
    const keptA = await roomA.say("owner", "kept in A");
    await agent.resetRoomSession(ROOM_A);
    await agent.resetRoomSession(ROOM_B);

    platform.control("play", null);
    const afterA = await roomA.say("owner", "after the play in A");
    const afterB = await roomB.say("owner", "after the play in B");

    for (const [room, ids] of [[roomA, [keptA, afterA]], [roomB, [keptB, afterB]]] as const) {
      for (const id of ids) expect(await room.outcome(id)).toBe("processed");
    }
    expect(handled.entries.map((turn) => turn.messageId).sort()).toEqual([keptA, afterA, keptB, afterB].sort());
  });

  it("runs nothing in a reset's closing session when Band plays the room mid-reset, and each kept message once afterwards", async () => {
    const { adapter, handled } = settlingAdapter();
    const { agent, platform, roomA, next } = await startAgent(adapter);
    platform.control("stop", ROOM_A);
    await next(is("room.paused", ROOM_A));
    // Each kept message makes the stopped room check /next for a missed play; holding the first holds the reset's close.
    const check = platform.rest.nextMessageHolds.hold((roomId) => roomId === ROOM_A);
    const first = await roomA.say("owner", "first kept");
    await check.sending;
    const second = await roomA.say("owner", "second kept");
    const reset = agent.resetRoomSession(ROOM_A);

    platform.control("play", ROOM_A);
    check.release();
    await reset;
    // The closing session's queued check found the play but ran nothing.
    expect(handled.entries).toEqual([]);
    const after = await roomA.say("owner", "after the reset");

    for (const id of [first, second, after]) expect(await roomA.outcome(id)).toBe("processed");
    expect(handled.entries.map((turn) => turn.messageId)).toEqual([first, second, after]);
  });

  it.each(["stop", "interrupt"] as const)("settles a claimed turn %s cut short while its first working report was in flight, before it started", async (mode) => {
    const bootstraps = new RecordLog<{ messageId: string; isSessionBootstrap: boolean }>();
    const adapter = new GenericAdapter(async ({ message, isSessionBootstrap, tools }) => {
      bootstraps.record({ messageId: message.id, isSessionBootstrap });
      tools.turn.settle();
    });
    const { platform, roomA, of } = await startAgent(adapter);
    const report = platform.rest.activityHolds.hold((roomId, working) => roomId === ROOM_A && working);
    const first = await roomA.say("owner", "first");
    await report.sending;

    platform.control(mode, ROOM_A);
    report.release();
    if (mode === "stop") {
      platform.control("play", ROOM_A);
    }

    expect(await roomA.outcome(first)).toBe("processed");
    expect((await roomA.sayAndSettle("owner", "second")).outcome).toBe("processed");
    const second = bootstraps.entries.at(-1)!.messageId;
    // Never started, so nothing to report as stopped: a stopped one replays as the session's first turn, an interrupted one is consumed unrun.
    expect(bootstraps.entries).toEqual(mode === "stop"
      ? [{ messageId: first, isSessionBootstrap: true }, { messageId: second, isSessionBootstrap: false }]
      : [{ messageId: second, isSessionBootstrap: true }]);
    expect(of(ROOM_A)).not.toContain("turn.stopped");
  });

  it("stops recovering a room's leftover messages once Band stops it", async () => {
    const platform = BandPlatform.host([person("owner")]);
    const roomA = await platform.room(ROOM_A);
    // Two turns an earlier run claimed and never settled.
    const first = roomA.postBeforeConnect("owner", "first leftover");
    const second = roomA.postBeforeConnect("owner", "second leftover");
    await platform.rest.markMessageProcessing(ROOM_A, first);
    await platform.rest.markMessageProcessing(ROOM_A, second);
    platform.rest.serveStaleProcessing = true;
    const handled = new RecordLog<string>();
    // The first recovered turn sees Band stop the room, and ends at once.
    const adapter = new GenericAdapter(async ({ message, tools }) => {
      handled.record(message.id);
      if (handled.entries.length === 1) platform.control("stop", ROOM_A);
      tools.turn.settle();
    });
    const { agent, events } = createAgent(platform, adapter);
    await agent.start();
    await events.next(is("turn.stopped", ROOM_A));

    // A graceful stop waits for the room to go idle: the second leftover never ran while Band held the room.
    await expect(agent.stop()).resolves.toBe(true);
    expect(handled.entries).toEqual([first]);
    expect(roomA.outcomes(second)).toEqual([]);
  });

  it.each([
    ["missed", false],
    ["delivered", true],
  ] as const)("keeps a newer Band stop when a missed-play check answered before it returns, with the play push %s", async (_label, playDelivered) => {
    const { adapter, handled } = settlingAdapter();
    const { platform, roomA, next, of } = await startAgent(adapter);
    platform.control("stop", ROOM_A);
    await next(is("room.paused", ROOM_A));
    // Band plays the room, and answers the check a delivered message starts while it plays.
    platform.control("play", ROOM_A, { delivered: false });
    const check = platform.rest.nextMessageHolds.hold((roomId) => roomId === ROOM_A);
    await roomA.say("owner", "while Band plays the room");
    await check.sending;
    if (playDelivered) {
      platform.control("play", ROOM_A, { delivered: true });
      await next(is("room.resumed", ROOM_A));
    }
    // Band stops the room again before the check's answer arrives.
    const before = of(ROOM_A).length;
    platform.control("stop", ROOM_A);
    if (playDelivered) await next(is("room.paused", ROOM_A), before);
    // The next /next read: a check the next message starts while the room stays paused.
    const later = platform.rest.nextMessageHolds.hold((roomId) => roomId === ROOM_A);
    check.release();
    await roomA.say("owner", "after Band stopped it again");
    await later.sending;

    expect(of(ROOM_A).at(-1)).toBe("room.paused");
    expect(handled.entries).toEqual([]);
  });

  it("does not lift a newer Band stop on a room's next execution with a check a forced reset left in flight", async () => {
    const { adapter, handled } = settlingAdapter();
    const { agent, platform, roomA, next, of } = await startAgent(adapter);
    platform.control("stop", ROOM_A);
    await next(is("room.paused", ROOM_A));
    platform.control("play", ROOM_A, { delivered: false });
    // Band answers this check while it plays the room; a second check queues behind it, so the room is not idle.
    const check = platform.rest.nextMessageHolds.hold((roomId) => roomId === ROOM_A);
    await roomA.say("owner", "kept");
    await check.sending;
    await roomA.say("owner", "queued behind the check");
    await agent.resetRoomSession(ROOM_A, 0);
    // Band stops the room again while no execution handles it.
    platform.control("stop", ROOM_A);
    const fresh = platform.rest.nextMessageHolds.hold((roomId) => roomId === ROOM_A);
    await roomA.say("owner", "after the reset");
    await fresh.sending;
    fresh.release();

    const later = platform.rest.nextMessageHolds.hold((roomId) => roomId === ROOM_A);
    check.release();
    await roomA.say("owner", "sync");
    await later.sending;
    later.release();

    expect(of(ROOM_A)).not.toContain("room.resumed");
    expect(handled.entries).toEqual([]);
  });
  it("keeps checking a room reset while Band stopped it, so a play whose push was missed is found on the interval", async () => {
    const { adapter, handled } = settlingAdapter();
    useFakeTimeouts();
    const { agent, platform, roomA, next, events } = await startAgent(adapter, { stoppedResyncSeconds: RESYNC_SECONDS });
    platform.control("stop", ROOM_A);
    await next(is("room.paused", ROOM_A));
    await agent.resetRoomSession(ROOM_A);
    await next(is("room.stopped", ROOM_A));
    // The room's next execution starts paused and checks /next at once; Band answers it while still stopped.
    const startCheck = platform.rest.nextMessageHolds.hold((roomId) => roomId === ROOM_A);
    const id = roomA.postBeforeConnect("owner", "bootstrapped");
    const bootstrapped = agent.bootstrapRoomMessage(ROOM_A, {
      id, roomId: ROOM_A, content: "bootstrapped", senderId: "owner", senderType: "User", senderName: "owner",
      messageType: "text", metadata: {}, createdAt: new Date(),
    });
    await startCheck.sending;
    // Band plays the room after answering that check, and the play push is missed.
    platform.control("play", ROOM_A, { delivered: false });
    const mark = events.entries.length;
    startCheck.release();

    await vi.advanceTimersByTimeAsync(RESYNC_MS - 1);
    expect(handled.entries).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await next(is("room.resumed", ROOM_A), mark);
    vi.useRealTimers();
    await bootstrapped;
    expect(handled.entries.map((turn) => turn.messageId)).toEqual([id]);
  });
});
