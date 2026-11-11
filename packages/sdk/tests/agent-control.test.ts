import type { Agent as AcpAgent } from "@agentclientprotocol/sdk";
import { describe, expect, it, onTestFinished } from "vitest";

import { ACPClientAdapter } from "../src/adapters/acp";
import { GenericAdapter, type GenericAdapterHandler } from "../src/adapters/GenericAdapter";
import { Agent } from "../src/agent/Agent";
import type { AgentEvent } from "../src/contracts/events";
import type { FrameworkAdapter } from "../src/contracts/protocols";
import { BandLink } from "../src/platform/BandLink";
import { AGENT_API_KEY, AGENT_ID, BandPlatform, person } from "./flows/support/bandPlatform";
import { inMemoryAgent } from "./support/inMemoryAcpAgent";
import { RecordLog, tmpRoot } from "./testUtils";

const ROOM_A = "room-a";
const ROOM_B = "room-b";

/** A handler whose first turn waits until the test ends, as one cut short while it works; later turns settle at once. */
function firstTurnHangs() {
  const handled = new RecordLog<{ roomId: string; messageId: string }>();
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
  };
  return { adapter: new GenericAdapter(handler), handled };
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

/** A started agent on a platform that has it in rooms A and B. */
async function startAgent(adapter: FrameworkAdapter) {
  const platform = BandPlatform.host([person("owner")]);
  const roomA = await platform.room(ROOM_A);
  const roomB = await platform.room(ROOM_B);
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
  /** Resolves with the next event at or after `from` that matches. */
  const next = (matches: (event: AgentEvent) => boolean, from = 0) => events.next(matches, from);
  const of = (roomId: string) =>
    events.entries.filter((event) => "roomId" in event && event.roomId === roomId).map((event) => event.type);
  return { agent, platform, roomA, roomB, events, next, of };
}

const is = <T extends AgentEvent["type"]>(type: T, roomId: string) =>
  (event: AgentEvent): event is Extract<AgentEvent, { type: T }> => event.type === type && "roomId" in event && event.roomId === roomId;

describe("agent.control from Band", () => {
  it("stops a room's running turn, leaves its message for Band, and replays it on play", async () => {
    const { adapter, handled } = firstTurnHangs();
    const { platform, roomA, next, of } = await startAgent(adapter);
    const first = await roomA.say("owner", "first");
    await handled.until(() => handled.entries.length === 1);

    platform.control("stop", ROOM_A);
    await next(is("turn.stopped", ROOM_A));
    // Neither settled nor run while stopped: Band keeps both for the room.
    const second = await roomA.say("owner", "second");
    expect(roomA.outcomes(first)).toEqual([]);
    expect(handled.entries).toHaveLength(1);

    platform.control("play", ROOM_A);
    expect(await roomA.outcome(first)).toBe("processed");
    expect(await roomA.outcome(second)).toBe("processed");
    expect(handled.entries.map((turn) => turn.messageId)).toEqual([first, first, second]);
    expect(of(ROOM_A)).toEqual([
      "room.joined",
      "turn.started", "room.paused", "turn.stopped",
      "room.resumed",
      "turn.started", "turn.completed", "turn.started", "turn.completed",
    ]);
  });

  it("interrupts a room's running turn and consumes its message, leaving the room running", async () => {
    const { adapter, handled } = firstTurnHangs();
    const { platform, roomA, next } = await startAgent(adapter);
    const first = await roomA.say("owner", "first");
    await handled.until(() => handled.entries.length === 1);

    platform.control("interrupt", ROOM_A);

    expect(await roomA.outcome(first)).toBe("processed");
    expect(await next(is("turn.stopped", ROOM_A))).toMatchObject({ messageId: first, mode: "interrupt" });
    expect((await roomA.sayAndSettle("owner", "second")).outcome).toBe("processed");
    expect(handled.entries).toHaveLength(2);
  });

  it("stops and plays every room for an agent-wide signal, and only the named room for a room signal", async () => {
    const { adapter, handled } = firstTurnHangs();
    const { platform, roomA, roomB, next } = await startAgent(adapter);
    // Uses up the handler's one hanging turn, so later turns settle.
    await roomA.say("owner", "warm-up");
    await handled.until(() => handled.entries.length === 1);
    platform.control("interrupt", ROOM_A);
    await next(is("turn.stopped", ROOM_A));

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
    const { adapter } = firstTurnHangs();
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
    const { adapter, handled } = firstTurnHangs();
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
    const { adapter, handled } = firstTurnHangs();
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
});
