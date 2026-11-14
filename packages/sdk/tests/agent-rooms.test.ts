import { chatRoomTopic } from "@band-ai/band-sdk-core";
import type { Agent as AcpAgent } from "@agentclientprotocol/sdk";
import { describe, expect, it, onTestFinished } from "vitest";

import { GenericAdapter } from "../src/adapters/GenericAdapter";
import { ACPClientAdapter } from "../src/adapters/acp";
import { Agent } from "../src/agent/Agent";
import type { MetadataMap } from "../src/contracts/dtos";
import type { AgentEvent } from "../src/contracts/events";
import type { FrameworkAdapter } from "../src/contracts/protocols";
import { BandLink } from "../src/platform/BandLink";
import { createDeferred } from "../src/core/deferred";
import { AGENT_API_KEY, AGENT_ID, BandPlatform, person } from "./flows/support/bandPlatform";
import { inMemoryAgent } from "./support/inMemoryAcpAgent";
import { RecordLog, tmpRoot } from "./testUtils";

const ROOM_A = "room-a";
const ROOM_B = "room-b";

/** An adapter that settles every turn without replying, recording the message it ran. */
function turnRecorder() {
  const turns = new RecordLog<string>();
  const adapter = new GenericAdapter(async ({ message, tools }) => {
    turns.record(message.id);
    tools.turn.settle();
  });
  return { adapter, turns };
}

/** A `turnRecorder` adapter whose `warmRoom` records each call; `fail` rejects the start. */
function warmRecorder(result: "identity" | "null" | "fail") {
  const warms = new RecordLog<string>();
  const { adapter: generic } = turnRecorder();
  const adapter: FrameworkAdapter = generic;
  adapter.warmRoom = async (roomId: string) => {
    warms.record(roomId);
    if (result === "fail") throw new Error("cannot start the room process");
    return result === "identity" ? { protocol: "omp-rpc" as const, protocolVersion: 2 } : null;
  };
  return { adapter, warms };
}

/** An agent on `platform`, observed from its first event; not started. */
function createAgent(adapter: FrameworkAdapter, platform: BandPlatform, roomFilter?: (room: MetadataMap) => boolean) {
  const agent = Agent.create({
    adapter,
    agentId: AGENT_ID,
    apiKey: AGENT_API_KEY,
    link: new BandLink({ agentId: AGENT_ID, apiKey: AGENT_API_KEY, ...platform.link }),
    roomFilter,
  });
  const events = new RecordLog<AgentEvent>();
  agent.observe((event) => {
    events.record(event);
  });
  onTestFinished(async () => {
    if (agent.isRunning) await agent.stop();
  });
  const subscribed = (roomId: string) => platform.transport.hasTopic(chatRoomTopic(roomId));
  const of = (roomId: string) =>
    events.entries.filter((event) => "roomId" in event && event.roomId === roomId).map((event) => event.type);
  /** Resolves once the agent reported `type` for `roomId`, at or after `from`. */
  const reported = (type: AgentEvent["type"], roomId: string, from = 0) =>
    events.next((event) => event.type === type && "roomId" in event && event.roomId === roomId, from);
  return { agent, events, subscribed, of, reported };
}

/** A started agent on a platform that has it in rooms A and B; `roomFilter` admits only `admit`. */
async function startAgent(adapter: FrameworkAdapter, admit: readonly string[] = [ROOM_A, ROOM_B]) {
  const platform = BandPlatform.host([person("owner")]);
  const roomA = await platform.room(ROOM_A);
  const roomB = await platform.room(ROOM_B);
  const observed = createAgent(adapter, platform, (room) => admit.includes(String(room.id)));
  await observed.agent.start();
  return { ...observed, platform, roomA, roomB };
}

describe("agent.rooms", () => {
  it("admits, after start, a member room the filter left out, and the room takes a turn", async () => {
    const { adapter, turns } = turnRecorder();
    const { agent, roomB, subscribed, of } = await startAgent(adapter, [ROOM_A]);
    expect(subscribed(ROOM_B)).toBe(false);

    await expect(agent.rooms.allow(ROOM_B)).resolves.toBe(true);
    await expect(agent.rooms.allow(ROOM_B)).resolves.toBe(true);

    expect(of(ROOM_B)).toEqual(["room.joined"]);
    expect((await roomB.sayAndSettle("owner", "hello")).outcome).toBe("processed");
    expect(turns.entries).toHaveLength(1);
  });

  it("pauses a denied room without leaving it, and replays what Band kept once it is allowed", async () => {
    const { adapter, turns } = turnRecorder();
    const { agent, roomA, roomB, subscribed, of } = await startAgent(adapter);

    await expect(agent.rooms.deny(ROOM_B)).resolves.toBe(true);
    // A repeat changes nothing: one pause reported, the turn not cancelled again.
    await expect(agent.rooms.deny(ROOM_B)).resolves.toBe(false);
    const held = await roomB.say("owner", "while denied");
    // Room events run in order, so once A's later turn settles, B's message was handled.
    expect((await roomA.sayAndSettle("owner", "still running")).outcome).toBe("processed");
    expect(subscribed(ROOM_B)).toBe(true);
    expect(roomB.outcomes(held)).toEqual([]);

    await expect(agent.rooms.allow(ROOM_B)).resolves.toBe(true);
    expect(await roomB.outcome(held)).toBe("processed");
    expect(of(ROOM_B)).toEqual(["room.joined", "room.paused", "room.resumed", "turn.started", "turn.completed"]);
    expect(turns.entries).toHaveLength(2);
  });

  it("cuts a denied room's running turn short, refuses its late reply, and answers once on allow", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    onTestFinished(() => release());
    const attempts = new RecordLog<string>();
    const adapter = new GenericAdapter(async ({ tools }) => {
      const first = attempts.entries.length === 0;
      attempts.record("started");
      if (first) await released;
      await tools.sendMessage(first ? "late reply" : "reply", ["owner"]).then(
        () => attempts.record("posted"),
        () => attempts.record("refused"),
      );
    });
    const { agent, roomA, reported } = await startAgent(adapter);
    const asked = await roomA.say("owner", "question");
    await attempts.until(() => attempts.entries.length === 1);

    await agent.rooms.deny(ROOM_A);
    await reported("turn.stopped", ROOM_A);
    release();
    await attempts.until(() => attempts.entries.length === 2);
    await agent.rooms.allow(ROOM_A);

    expect(await roomA.outcome(asked)).toBe("processed");
    expect(attempts.entries).toEqual(["started", "refused", "started", "posted"]);
    expect(roomA.messages.map((posted) => posted.content)).toEqual(["reply"]);
  });

  it("starts a room denied before start paused, and runs its backlog once allowed", async () => {
    const { adapter, turns } = turnRecorder();
    const platform = BandPlatform.host([person("owner")]);
    const roomA = await platform.room(ROOM_A);
    const waiting = roomA.postBeforeConnect("owner", "sent while the agent was away");
    const { agent, of } = createAgent(adapter, platform);

    await expect(agent.rooms.deny(ROOM_A)).resolves.toBe(false);
    await agent.start();
    // A graceful stop waits until the room is idle: an unpaused room would have run its backlog by then.
    await expect(agent.stop()).resolves.toBe(true);
    expect(turns.entries).toEqual([]);
    expect(roomA.outcomes(waiting)).toEqual([]);
    expect(of(ROOM_A)).toEqual(["room.paused", "room.joined", "room.stopped"]);

    await agent.start();
    await agent.rooms.allow(ROOM_A);
    expect(await roomA.outcome(waiting)).toBe("processed");
  });

  it("starts paused a denied room Band adds the agent to later", async () => {
    const { adapter, turns } = turnRecorder();
    const { agent, platform, roomA, of } = await startAgent(adapter, [ROOM_A, ROOM_B, "room-c"]);
    await expect(agent.rooms.deny("room-c")).resolves.toBe(false);

    const roomC = await platform.room("room-c");
    const held = await roomC.say("owner", "while denied");
    expect((await roomA.sayAndSettle("owner", "still running")).outcome).toBe("processed");
    expect(roomC.outcomes(held)).toEqual([]);

    await agent.rooms.allow("room-c");
    expect(await roomC.outcome(held)).toBe("processed");
    expect(of("room-c")).toEqual(["room.paused", "room.joined", "room.resumed", "turn.started", "turn.completed"]);
    expect(turns.entries).toHaveLength(2);
  });

  it("keeps Band's stop and the host's deny apart: the room runs only once both are lifted", async () => {
    const { adapter, turns } = turnRecorder();
    const { agent, platform, roomA, events, reported } = await startAgent(adapter);
    await agent.rooms.deny(ROOM_A);
    // From here, so the host's own pause, reported already, does not count as Band's.
    const beforeStop = events.entries.length;
    platform.control("stop", ROOM_A);
    await reported("room.paused", ROOM_A, beforeStop);
    const held = await roomA.say("owner", "while paused twice");

    await agent.rooms.allow(ROOM_A);
    platform.control("stop", ROOM_B);
    await reported("room.paused", ROOM_B);
    expect(turns.entries).toEqual([]);

    platform.control("play", ROOM_A);
    expect(await roomA.outcome(held)).toBe("processed");
    expect(turns.entries).toEqual([held]);
  });

  it("keeps its decisions across a restart of the same agent", async () => {
    const { adapter, turns } = turnRecorder();
    const { agent, roomA, roomB, subscribed } = await startAgent(adapter, [ROOM_A]);
    await agent.rooms.allow(ROOM_B);
    await agent.rooms.deny(ROOM_A);
    await agent.stop();

    await agent.start();

    expect(subscribed(ROOM_B)).toBe(true);
    const held = await roomA.say("owner", "after the restart");
    expect((await roomB.sayAndSettle("owner", "allowed room runs")).outcome).toBe("processed");
    expect(roomA.outcomes(held)).toEqual([]);
    await agent.rooms.allow(ROOM_A);
    expect(await roomA.outcome(held)).toBe("processed");
    expect(turns.entries).toHaveLength(2);
  });

  it("admits a member room allowed while start is joining the rooms before it", async () => {
    const { adapter } = turnRecorder();
    const platform = BandPlatform.host([person("owner")]);
    const roomA = await platform.room(ROOM_A);
    await platform.room(ROOM_B);
    const { agent, subscribed } = createAgent(adapter, platform, (room) => room.id === ROOM_A);
    const releaseA = roomA.holdJoin();

    const starting = agent.start();
    // Rooms are listed, then joined one at a time: B was already passed over while A's join is held.
    await platform.transport.joining.next((topic) => topic === chatRoomTopic(ROOM_A));
    await expect(agent.rooms.allow(ROOM_B)).resolves.toBe(false);
    releaseA();
    await starting;

    expect(subscribed(ROOM_B)).toBe(true);
  });

  it("answers false to allowing a room the agent is not in, and admits it once Band adds the agent", async () => {
    const { adapter } = turnRecorder();
    const { agent, platform, subscribed } = await startAgent(adapter, [ROOM_A]);

    await expect(agent.rooms.allow("room-c")).resolves.toBe(false);
    await platform.room("room-c");

    await platform.transport.bound.until(() => subscribed("room-c"));
  });

  it("warms a member room on allow, reporting room.ready with its identity before the room joins", async () => {
    const { adapter, warms } = warmRecorder("identity");
    const { agent, subscribed, of } = await startAgent(adapter, [ROOM_A]);

    await expect(agent.rooms.allow(ROOM_B, { warm: true })).resolves.toBe(true);

    expect(warms.entries).toEqual([ROOM_B]);
    expect(of(ROOM_B)).toEqual(["room.ready", "room.joined"]);
    expect(subscribed(ROOM_B)).toBe(true);
  });

  it("reports room.ready with no agent identity when the adapter starts nothing ahead", async () => {
    const { adapter, warms } = warmRecorder("null");
    const { agent, events } = await startAgent(adapter, [ROOM_A]);

    await agent.rooms.allow(ROOM_B, { warm: true });

    expect(warms.entries).toEqual([ROOM_B]);
    expect(events.entries.find((event) => event.type === "room.ready")).toEqual({
      type: "room.ready",
      roomId: ROOM_B,
      agent: null,
    });
  });

  it("reports room.failed once for a warm that cannot start, and still admits the room", async () => {
    const { adapter, warms } = warmRecorder("fail");
    const { agent, of, roomB } = await startAgent(adapter, [ROOM_A]);

    await expect(agent.rooms.allow(ROOM_B, { warm: true })).resolves.toBe(true);

    expect(warms.entries).toEqual([ROOM_B]);
    expect(of(ROOM_B)).toEqual(["room.failed", "room.joined"]);
    // Still allowed: the room's messages take turns even though its warm failed.
    expect((await roomB.sayAndSettle("owner", "after a failed warm")).outcome).toBe("processed");
  });

  it("does not warm a room Band has not added the agent to; its later admit starts lazily", async () => {
    const { adapter, warms } = warmRecorder("identity");
    const { agent, platform, subscribed } = await startAgent(adapter, [ROOM_A]);

    await expect(agent.rooms.allow("room-c", { warm: true })).resolves.toBe(false);
    expect(warms.entries).toEqual([]);

    await platform.room("room-c");
    await platform.transport.bound.until(() => subscribed("room-c"));
    expect(warms.entries).toEqual([]);
  });

  it("warms a room's ACP agent on allow, reporting what its handshake named", async () => {
    let initialized = 0;
    const adapter = new ACPClientAdapter({
      command: ["acp-fixture"],
      cwd: tmpRoot(),
      enableMcpTools: false,
      connectionFactory: inMemoryAgent((): AcpAgent => ({
        initialize: async () => {
          initialized += 1;
          return {
            protocolVersion: 1,
            agentCapabilities: {},
            agentInfo: { name: "fixture-acp", title: "Fixture", version: "1.2.3" },
          };
        },
        authenticate: async () => ({}),
        newSession: async () => ({ sessionId: "session-1" }),
        cancel: async () => {},
        prompt: async () => ({ stopReason: "end_turn" }),
      })),
    });
    const { agent, events, subscribed, of } = await startAgent(adapter, [ROOM_A]);

    await expect(agent.rooms.allow(ROOM_B, { warm: true })).resolves.toBe(true);

    expect(initialized).toBe(1);
    expect(of(ROOM_B)).toEqual(["room.ready", "room.joined"]);
    expect(events.entries.find((event) => event.type === "room.ready")).toEqual({
      type: "room.ready",
      roomId: ROOM_B,
      agent: { protocol: "acp", protocolVersion: 1, agentInfo: { name: "fixture-acp", version: "1.2.3" } },
    });
    expect(subscribed(ROOM_B)).toBe(true);
  });

  it("reports a warm ACP room whose agent names no implementation with agentInfo null", async () => {
    const adapter = new ACPClientAdapter({
      command: ["acp-fixture"],
      cwd: tmpRoot(),
      enableMcpTools: false,
      connectionFactory: inMemoryAgent((): AcpAgent => ({
        initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }),
        authenticate: async () => ({}),
        newSession: async () => ({ sessionId: "session-1" }),
        cancel: async () => {},
        prompt: async () => ({ stopReason: "end_turn" }),
      })),
    });
    const { agent, events } = await startAgent(adapter, [ROOM_A]);

    await agent.rooms.allow(ROOM_B, { warm: true });

    expect(events.entries.find((event) => event.type === "room.ready")).toMatchObject({
      agent: { protocol: "acp", protocolVersion: 1, agentInfo: null },
    });
  });

  it("keeps a denied room paused across a reset of its session", async () => {
    const { adapter, turns } = turnRecorder();
    const { agent, roomA, roomB, of } = await startAgent(adapter);
    await agent.rooms.deny(ROOM_A);

    await agent.resetRoomSession(ROOM_A);
    const held = await roomA.say("owner", "after the reset");
    expect((await roomB.sayAndSettle("owner", "still running")).outcome).toBe("processed");
    expect(roomA.outcomes(held)).toEqual([]);
    expect(of(ROOM_A)).toEqual(["room.joined", "room.paused", "room.stopped", "room.joined"]);

    await agent.rooms.allow(ROOM_A);
    expect(await roomA.outcome(held)).toBe("processed");
    expect(turns.entries).toHaveLength(2);
  });

  it("starts despite a room listing that fails, and admits an allowed room once Band adds the agent", async () => {
    const { adapter } = turnRecorder();
    const platform = BandPlatform.host([person("owner")]);
    await platform.room(ROOM_A);
    // The filter declines room-c, so only the allow admits it.
    const { agent, subscribed } = createAgent(adapter, platform, (room) => room.id === ROOM_A);
    await expect(agent.rooms.allow("room-c")).resolves.toBe(false);
    // Both of start's listings fail: its own, and the one that admits the allowed rooms.
    for (let listing = 0; listing < 2; listing += 1) {
      platform.rest.listHolds.hold(() => true, { error: new Error("Band is unavailable") }).release();
    }

    await agent.start();

    expect(agent.isRunning).toBe(true);
    await platform.room("room-c");
    await platform.transport.bound.until(() => subscribed("room-c"));
  });

  it("does not admit an allowed room into an agent stopped while it was listing the rooms", async () => {
    const { adapter } = turnRecorder();
    const { agent, platform, subscribed, of } = await startAgent(adapter, [ROOM_A]);
    const listing = platform.rest.listHolds.hold(() => true);
    const allowing = agent.rooms.allow(ROOM_B);
    await listing.sending;

    await agent.stop();
    listing.release();

    await expect(allowing).resolves.toBe(false);
    expect(subscribed(ROOM_B)).toBe(false);
    expect(of(ROOM_B)).toEqual([]);
  });

  it("replays what Band kept for a denied room reset meanwhile on the room's next message after it is allowed", async () => {
    const { adapter, turns } = turnRecorder();
    const { agent, roomA, roomB } = await startAgent(adapter);
    await agent.rooms.deny(ROOM_A);
    const held = await roomA.say("owner", "while denied");
    expect((await roomB.sayAndSettle("owner", "still running")).outcome).toBe("processed");
    await agent.resetRoomSession(ROOM_A);

    await expect(agent.rooms.allow(ROOM_A)).resolves.toBe(true);
    const next = await roomA.say("owner", "after the allow");

    expect(await roomA.outcome(held)).toBe("processed");
    expect(await roomA.outcome(next)).toBe("processed");
    expect(turns.entries).toHaveLength(3);
  });

  it("resolves false, not rejecting, when allow's own listing fails, and admits the room on the next reconnect", async () => {
    const { adapter } = turnRecorder();
    const { agent, platform, subscribed } = await startAgent(adapter, [ROOM_A]);
    platform.rest.listHolds.hold(() => true, { error: new Error("Band is unavailable") }).release();

    await expect(agent.rooms.allow(ROOM_B)).resolves.toBe(false);
    expect(subscribed(ROOM_B)).toBe(false);

    await platform.transport.triggerReconnect({ generation: 1, joinedTopics: new Set(platform.transport.bound.entries) });
    await platform.transport.bound.until(() => subscribed(ROOM_B));
  });

  it("keeps an allowed room the filter declines across a reconnect", async () => {
    const { adapter, turns } = turnRecorder();
    const { agent, platform, roomB, subscribed, of } = await startAgent(adapter, [ROOM_A]);
    await agent.rooms.allow(ROOM_B);

    await platform.transport.triggerReconnect({ generation: 1, joinedTopics: new Set(platform.transport.bound.entries) });

    expect(subscribed(ROOM_B)).toBe(true);
    expect((await roomB.sayAndSettle("owner", "after the reconnect")).outcome).toBe("processed");
    expect(of(ROOM_B)).not.toContain("room.left");
    expect(turns.entries).toHaveLength(1);
  });

  it("keeps the host's deny when Band plays a room it stopped first", async () => {
    const { adapter, turns } = turnRecorder();
    const { agent, platform, roomA, roomB, events, reported } = await startAgent(adapter);
    const beforeStop = events.entries.length;
    platform.control("stop", ROOM_A);
    await reported("room.paused", ROOM_A, beforeStop);
    await agent.rooms.deny(ROOM_A);
    const held = await roomA.say("owner", "while paused twice");

    platform.control("play", ROOM_A);
    // Room events run in order, so once B's later turn settles, A's play and message were handled.
    expect((await roomB.sayAndSettle("owner", "still running")).outcome).toBe("processed");
    expect(roomA.outcomes(held)).toEqual([]);

    await agent.rooms.allow(ROOM_A);
    expect(await roomA.outcome(held)).toBe("processed");
    expect(turns.entries).toHaveLength(2);
  });

  it("neither admits nor runs an allowed room whose join a stop overtook", async () => {
    const released = createDeferred();
    onTestFinished(() => released.resolve());
    const turns = new RecordLog<string>();
    const adapter = new GenericAdapter(async ({ roomId, tools }) => {
      turns.record(roomId);
      // A's turn holds A's graceful stop open while B's join lands.
      if (roomId === ROOM_A) await released.promise;
      tools.turn.settle();
    });
    const platform = BandPlatform.host([person("owner")]);
    const roomA = await platform.room(ROOM_A);
    const roomB = await platform.room(ROOM_B);
    const backlog = roomB.postBeforeConnect("owner", "waiting in B");
    const { agent, of, subscribed } = createAgent(adapter, platform, (room) => room.id === ROOM_A);
    await agent.start();
    await roomA.say("owner", "hold A");
    await turns.until(() => turns.entries.length === 1);
    const releaseJoinB = roomB.holdJoin();
    const allowing = agent.rooms.allow(ROOM_B);
    await platform.transport.joining.next((topic) => topic === chatRoomTopic(ROOM_B));

    const stopping = agent.stop();
    releaseJoinB();
    await expect(allowing).resolves.toBe(false);
    released.resolve();
    await stopping;

    expect(of(ROOM_B)).toEqual([]);
    expect(subscribed(ROOM_B)).toBe(false);
    expect(turns.entries).toEqual([ROOM_A]);
    expect(roomB.outcomes(backlog)).toEqual([]);
  });
  it("resolves true for an allow whose listing a restart overtook, once the restarted agent admitted the room", async () => {
    const { adapter } = turnRecorder();
    const { agent, platform, subscribed } = await startAgent(adapter, [ROOM_A]);
    const listing = platform.rest.listHolds.hold(() => true);
    const allowing = agent.rooms.allow(ROOM_B);
    await listing.sending;

    await agent.stop();
    await agent.start();
    listing.release();

    await expect(allowing).resolves.toBe(true);
    expect(subscribed(ROOM_B)).toBe(true);
  });

  it("resolves an allow made while start is still joining rooms with whether the room is admitted", async () => {
    const { adapter } = turnRecorder();
    const platform = BandPlatform.host([person("owner")]);
    await platform.room(ROOM_A);
    const roomB = await platform.room(ROOM_B);
    const { agent, subscribed } = createAgent(adapter, platform);
    const releaseB = roomB.holdJoin();
    const starting = agent.start();
    // Rooms join one at a time: A is admitted while B's join is held.
    await platform.transport.joining.next((topic) => topic === chatRoomTopic(ROOM_B));
    expect(subscribed(ROOM_A)).toBe(true);

    await expect(agent.rooms.allow(ROOM_A)).resolves.toBe(true);
    releaseB();
    await starting;
  });
});
