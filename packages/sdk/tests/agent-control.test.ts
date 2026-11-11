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
import { createDeferred } from "../src/core/deferred";
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
    const { platform, roomA, roomB, next } = await startAgent(adapter);
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
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { platform, roomA, next } = await startAgent(adapter, { stoppedResyncSeconds: 30 });
    platform.control("stop", ROOM_A);
    await next(is("room.paused", ROOM_A));
    const waiting = await roomA.say("owner", "while stopped");
    platform.control("play", ROOM_A, { delivered: false });

    await vi.advanceTimersByTimeAsync(29_999);
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
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { platform, roomA, next } = await startAgent(adapter, { stoppedResyncSeconds: 30 });
    platform.control("stop", ROOM_A);
    await next(is("room.paused", ROOM_A));
    // The check the delivered message starts, while Band still has the room stopped.
    const deliveredCheck = platform.rest.nextMessageHolds.hold((roomId) => roomId === ROOM_A);
    const waiting = await roomA.say("owner", "while stopped");
    await deliveredCheck.sending;
    deliveredCheck.release();
    platform.control("play", ROOM_A, { delivered: false });
    const failedCheck = platform.rest.nextMessageHolds.hold((roomId) => roomId === ROOM_A, { error: new Error("Band unavailable") });

    await vi.advanceTimersByTimeAsync(30_000);
    await failedCheck.sending;
    failedCheck.release();
    await vi.advanceTimersByTimeAsync(30_000);

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
});
