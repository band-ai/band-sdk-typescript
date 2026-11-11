import type { Agent as AcpAgent } from "@agentclientprotocol/sdk";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { ACPClientAdapter } from "../src/adapters/acp";
import { GenericAdapter, type GenericAdapterHandler } from "../src/adapters/GenericAdapter";
import { Agent } from "../src/agent/Agent";
import type { AgentEvent } from "../src/contracts/events";
import type { FrameworkAdapter } from "../src/contracts/protocols";
import { BandLink } from "../src/platform/BandLink";
import type { SessionConfig } from "../src/runtime/types";
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
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  onTestFinished(() => release());
  const handler: GenericAdapterHandler = async ({ roomId, message, tools }) => {
    handled.record({ roomId, messageId: message.id });
    if (handled.entries.length === 1) {
      await released;
    }
    tools.turn.settle();
    ended.record(message.id);
  };
  return { adapter: new GenericAdapter(handler), handled, ended, release };
}

/** Lets every queued microtask and I/O callback run: the in-process platform answers on microtasks. */
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A handler that settles every turn at once, recording it. */
function settlingAdapter() {
  const handled = new RecordLog<{ roomId: string; messageId: string }>();
  const adapter = new GenericAdapter(async ({ roomId, message, tools }) => {
    handled.record({ roomId, messageId: message.id });
    tools.turn.settle();
  });
  return { adapter, handled };
}

/** A started agent on a platform that has it in rooms A and B. */
async function startAgent(adapter: FrameworkAdapter, sessionConfig?: SessionConfig) {
  const platform = BandPlatform.host([person("owner")]);
  const roomA = await platform.room(ROOM_A);
  const roomB = await platform.room(ROOM_B);
  const agent = Agent.create({
    adapter,
    agentId: AGENT_ID,
    apiKey: AGENT_API_KEY,
    link: new BandLink({ agentId: AGENT_ID, apiKey: AGENT_API_KEY, ...platform.link }),
    sessionConfig,
  });
  const events = new RecordLog<AgentEvent>();
  agent.observe((event) => {
    events.record(event);
  });
  await agent.start();
  onTestFinished(async () => {
    if (agent.isRunning) await agent.stop();
  });
  /** Resolves with the next event at or after `from` that matches. */
  const next = (matches: (event: AgentEvent) => boolean, from = 0) => events.next(matches, from);
  const of = (roomId: string) =>
    events.entries.filter((event) => "roomId" in event && event.roomId === roomId).map((event) => event.type);
  return { agent, platform, roomA, roomB, events, next, of };
}

const is = <T extends AgentEvent["type"]>(type: T, roomId: string) =>
  (event: AgentEvent): event is Extract<AgentEvent, { type: T }> => event.type === type && "roomId" in event && event.roomId === roomId;

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

    platform.control("play", ROOM_A);
    await next(is("room.resumed", ROOM_A));
    await drain();
    // The adapter could not cancel the cut-short turn, so the replay waits for it.
    expect(handled.entries).toHaveLength(1);
    release();

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
    let cancelled!: () => void;
    const cancelRequested = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    let prompted!: () => void;
    const promptStarted = new Promise<void>((resolve) => {
      prompted = resolve;
    });
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
            cancelled();
            cancel();
          },
          prompt: async () => {
            const ended = new Promise<void>((resolve) => {
              cancel = resolve;
            });
            prompted();
            await ended;
            return { stopReason: "cancelled" };
          },
        };
      }),
    });
    const { platform, roomA, next } = await startAgent(adapter);
    const first = await roomA.say("owner", "first");
    await promptStarted;

    platform.control("stop", ROOM_A);

    expect(await next(is("turn.stopped", ROOM_A))).toMatchObject({ messageId: first, mode: "stop" });
    await cancelRequested;
    expect(roomA.outcomes(first)).toEqual([]);
  });

  it("stops a backlog turn the start-up catch-up is running, and replays it on play", async () => {
    const { adapter, handled, release } = firstTurnHangs();
    const platform = BandPlatform.host([person("owner")]);
    const roomA = await platform.room(ROOM_A);
    const missed = roomA.postBeforeConnect("owner", "sent while the agent was away");
    const agent = Agent.create({
      adapter,
      agentId: AGENT_ID,
      apiKey: AGENT_API_KEY,
      link: new BandLink({ agentId: AGENT_ID, apiKey: AGENT_API_KEY, ...platform.link }),
    });
    const events = new RecordLog<AgentEvent>();
    agent.observe((event) => {
      events.record(event);
    });
    await agent.start();
    onTestFinished(async () => {
      if (agent.isRunning) await agent.stop();
    });
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
    let gate!: () => void;
    const gated = new Promise<void>((resolve) => {
      gate = resolve;
    });
    onTestFinished(() => gate());
    const posts = new RecordLog<string>();
    const adapter = new GenericAdapter(async ({ message, tools }) => {
      posts.record(message.id);
      if (posts.entries.length === 1) await gated;
      await tools.sendMessage("done", ["owner"]);
    });
    const { platform, roomA, next } = await startAgent(adapter);
    const first = await roomA.say("owner", "first");
    await posts.until(() => posts.entries.length === 1);

    platform.control("stop", ROOM_A, { delivered: false });
    gate();

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
    const agent = Agent.create({
      adapter,
      agentId: AGENT_ID,
      apiKey: AGENT_API_KEY,
      link: new BandLink({ agentId: AGENT_ID, apiKey: AGENT_API_KEY, ...platform.link }),
    });
    const events = new RecordLog<AgentEvent>();
    agent.observe((event) => {
      events.record(event);
    });
    onTestFinished(async () => {
      if (agent.isRunning) await agent.stop();
    });

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
});
