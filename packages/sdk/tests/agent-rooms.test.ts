import { chatRoomTopic } from "@band-ai/band-sdk-core";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { GenericAdapter } from "../src/adapters/GenericAdapter";
import { Agent } from "../src/agent/Agent";
import type { MetadataMap } from "../src/contracts/dtos";
import type { AgentEvent } from "../src/contracts/events";
import type { FrameworkAdapter } from "../src/contracts/protocols";
import { BandLink } from "../src/platform/BandLink";
import { AGENT_API_KEY, AGENT_ID, BandPlatform, person } from "./flows/support/bandPlatform";
import { RecordLog } from "./testUtils";

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
    expect(turns.entries).toEqual([]);
    expect(of(ROOM_A)).toEqual(["room.paused", "room.joined"]);

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
    const { agent, platform, roomA, reported } = await startAgent(adapter);
    await agent.rooms.deny(ROOM_A);
    platform.control("stop", ROOM_A);
    await reported("room.paused", ROOM_A);
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
    await platform.room(ROOM_A);
    await platform.room(ROOM_B);
    const { agent, subscribed } = createAgent(adapter, platform, (room) => room.id === ROOM_A);
    const releaseA = platform.transport.gateJoin(chatRoomTopic(ROOM_A));

    const starting = agent.start();
    // Rooms are listed, then joined one at a time: B was already passed over while A's join is held.
    await vi.waitFor(() => expect(platform.transport.joinCalls).toContain(chatRoomTopic(ROOM_A)));
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
});
