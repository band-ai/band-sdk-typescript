import type { Agent as AcpAgent } from "@agentclientprotocol/sdk";
import { chatRoomTopic } from "@band-ai/band-sdk-core";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { ACPClientAdapter } from "../src/adapters/acp";
import { GenericAdapter } from "../src/adapters/GenericAdapter";
import { Agent } from "../src/agent/Agent";
import type { FrameworkAdapter } from "../src/contracts/protocols";
import type { MetadataMap } from "../src/contracts/dtos";
import type { AgentEvent } from "../src/contracts/events";
import { BandLink } from "../src/platform/BandLink";
import { AGENT_API_KEY, AGENT_ID, BandPlatform, person } from "./flows/support/bandPlatform";
import { inMemoryAgent } from "./support/inMemoryAcpAgent";
import { RecordLog, tmpRoot } from "./testUtils";

const ROOM_A = "room-a";
const ROOM_B = "room-b";

/** An adapter that settles every turn without replying, recording the room it ran in. */
function turnRecorder() {
  const turns: string[] = [];
  const adapter = new GenericAdapter(async ({ roomId, tools }) => {
    turns.push(roomId);
    tools.turn.settle();
  });
  return { adapter, turns };
}

/** An ACP adapter whose agent's `initialize` waits for `release`, counting the room processes it starts and stops. */
function heldAcpAdapter() {
  const counts = { started: 0, stopped: 0 };
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const initializing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const stops = new RecordLog<number>();
  const adapter = new ACPClientAdapter({
    command: ["acp-fixture"],
    cwd: tmpRoot(),
    enableMcpTools: false,
    connectionFactory: inMemoryAgent(
      (): AcpAgent => ({
        initialize: async () => {
          counts.started += 1;
          entered();
          await released;
          return { protocolVersion: 1, agentCapabilities: {} };
        },
        authenticate: async () => ({}),
        newSession: async () => ({ sessionId: "session-1" }),
        cancel: async () => {},
        prompt: async () => ({ stopReason: "end_turn" }),
      }),
      () => {
        counts.stopped += 1;
        stops.record(counts.stopped);
      },
    ),
  });
  return { adapter, counts, release, initializing, stops };
}

/** Holds the agent's next room listing on Band until `release`, resolving `listing` once it is requested. */
function holdNextRoomListing(platform: BandPlatform) {
  const listChats = platform.rest.listChats.bind(platform.rest);
  let entered!: () => void;
  const listing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  platform.rest.listChats = async (...args: Parameters<typeof listChats>) => {
    if (!held) {
      held = true;
      entered();
      await released;
    }
    return await listChats(...args);
  };
  onTestFinished(() => release());
  return { listing, release };
}

/** An agent created on `platform`, observed from its first event. */
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
  const roomEvents = (roomId: string) =>
    events.entries.filter((event) => "roomId" in event && event.roomId === roomId).map((event) => event.type);
  /** Resolves once the agent reported `type` for `roomId`, so every event reported before it was delivered too. */
  const reported = (type: AgentEvent["type"], roomId: string) =>
    events.next((event) => event.type === type && "roomId" in event && event.roomId === roomId);
  return { agent, events, subscribed, roomEvents, reported };
}

/** An agent on a platform that has it in rooms A and B; `roomFilter` admits only `admit` at start. */
async function startAgent(adapter: FrameworkAdapter, admit: readonly string[] = [ROOM_A, ROOM_B]) {
  const platform = BandPlatform.host([person("owner")]);
  const roomA = await platform.room(ROOM_A);
  const roomB = await platform.room(ROOM_B);
  const observed = createAgent(adapter, platform, (room) => admit.includes(String(room.id)));
  await observed.agent.start();
  return { ...observed, platform, roomA, roomB };
}

describe("agent.rooms", () => {
  it("admits, after start, a room the filter left out, and the room takes a turn", async () => {
    const { adapter, turns } = turnRecorder();
    const { agent, roomB, subscribed, roomEvents } = await startAgent(adapter, [ROOM_A]);
    expect(subscribed(ROOM_B)).toBe(false);

    await expect(agent.rooms.allow(ROOM_B)).resolves.toBe(true);

    expect(subscribed(ROOM_B)).toBe(true);
    expect(roomEvents(ROOM_B)).toEqual(["room.joined"]);
    expect((await roomB.sayAndSettle("owner", "hello")).outcome).toBe("processed");
    expect(turns).toEqual([ROOM_B]);
  });

  it("leaves an admitted room as it is on allow", async () => {
    const { adapter } = turnRecorder();
    const { agent, roomEvents } = await startAgent(adapter);

    await expect(agent.rooms.allow(ROOM_B)).resolves.toBe(true);

    expect(roomEvents(ROOM_B)).toEqual(["room.joined"]);
  });

  it("leaves a room on deny: no more turns, and its topic is dropped", async () => {
    const { adapter, turns } = turnRecorder();
    const { agent, platform, roomA, subscribed, roomEvents } = await startAgent(adapter);
    expect(subscribed(ROOM_B)).toBe(true);

    await expect(agent.rooms.deny(ROOM_B)).resolves.toBe(true);

    expect(subscribed(ROOM_B)).toBe(false);
    // The agent stays a member, so the room is stopped, not left.
    expect(roomEvents(ROOM_B)).toEqual(["room.joined", "room.stopped"]);
    // Band announcing the room again does not bring it back: room events run in
    // order, so once a later allowed room is joined, B's announcement was handled.
    await agent.rooms.allow("room-c");
    await platform.room(ROOM_B);
    await platform.room("room-c");
    await platform.transport.bound.until(() => subscribed("room-c"));
    expect(subscribed(ROOM_B)).toBe(false);
    expect((await roomA.sayAndSettle("owner", "still here?")).outcome).toBe("processed");
    expect(turns).toEqual([ROOM_A]);
  });

  it("admits a denied room again on allow", async () => {
    const { adapter, turns } = turnRecorder();
    const { agent, roomB, subscribed } = await startAgent(adapter);
    await agent.rooms.deny(ROOM_B);

    await expect(agent.rooms.allow(ROOM_B)).resolves.toBe(true);

    expect(subscribed(ROOM_B)).toBe(true);
    expect((await roomB.sayAndSettle("owner", "back")).outcome).toBe("processed");
    expect(turns).toEqual([ROOM_B]);
  });

  it("answers false for a room it is not in, and admits it once Band adds the agent", async () => {
    const { adapter } = turnRecorder();
    const { agent, platform, subscribed } = await startAgent(adapter, [ROOM_A]);

    await expect(agent.rooms.allow("room-c")).resolves.toBe(false);
    await expect(agent.rooms.deny("room-d")).resolves.toBe(false);
    expect(subscribed("room-c")).toBe(false);

    // Room events run in order, so once room-c is joined, room-d's announcement was handled.
    await platform.room("room-d");
    await platform.room("room-c");
    await platform.transport.bound.until(() => subscribed("room-c"));
    expect(subscribed("room-d")).toBe(false);
  });

  it("reports room.failed, and never room.ready, when a warm room's agent cannot start", async () => {
    const adapter = new ACPClientAdapter({
      command: ["/nonexistent/band-acp-agent"],
      cwd: tmpRoot(),
      enableMcpTools: false,
    });
    const { agent, roomEvents } = await startAgent(adapter, [ROOM_A]);

    // Still allowed: its messages fail until a later start succeeds, as for any room whose agent cannot start.
    await expect(agent.rooms.allow(ROOM_B, { warm: true })).resolves.toBe(true);

    expect(roomEvents(ROOM_B)).toEqual(["room.failed", "room.joined"]);
  });

  it("starts a warm room's agent and reports room.ready before the room is joined", async () => {
    let initialized = 0;
    const adapter = new ACPClientAdapter({
      command: ["acp-fixture"],
      cwd: tmpRoot(),
      enableMcpTools: false,
      connectionFactory: inMemoryAgent((): AcpAgent => ({
        initialize: async () => {
          initialized += 1;
          return { protocolVersion: 1, agentCapabilities: {} };
        },
        authenticate: async () => ({}),
        newSession: async () => ({ sessionId: "session-1" }),
        cancel: async () => {},
        prompt: async () => ({ stopReason: "end_turn" }),
      })),
    });
    const { agent, subscribed, roomEvents } = await startAgent(adapter, [ROOM_A]);

    await expect(agent.rooms.allow(ROOM_B, { warm: true })).resolves.toBe(true);

    expect(initialized).toBe(1);
    expect(roomEvents(ROOM_B)).toEqual(["room.ready", "room.joined"]);
    expect(subscribed(ROOM_B)).toBe(true);
  });

  it("reports room.ready and joins a warm room for an adapter that starts nothing ahead", async () => {
    const { adapter } = turnRecorder();
    const { agent, roomEvents } = await startAgent(adapter, [ROOM_A]);

    await expect(agent.rooms.allow(ROOM_B, { warm: true })).resolves.toBe(true);

    expect(roomEvents(ROOM_B)).toEqual(["room.ready", "room.joined"]);
  });

  it("keeps decisions across a restart: a denied room is not hydrated, an allowed one is", async () => {
    const { adapter } = turnRecorder();
    const { agent, subscribed } = await startAgent(adapter, [ROOM_A]);
    await agent.rooms.deny(ROOM_A);
    await agent.rooms.allow(ROOM_B);
    await agent.stop();

    await agent.start();

    expect(subscribed(ROOM_A)).toBe(false);
    expect(subscribed(ROOM_B)).toBe(true);
  });

  it("keeps a denied room out across a reconnect", async () => {
    const { adapter } = turnRecorder();
    const { agent, platform, subscribed } = await startAgent(adapter);
    await agent.rooms.deny(ROOM_B);

    await platform.transport.triggerReconnect({ generation: 1, joinedTopics: new Set(platform.transport.bound.entries) });

    expect(subscribed(ROOM_A)).toBe(true);
    expect(subscribed(ROOM_B)).toBe(false);
  });

  it("stops a warmed room's process when a deny supersedes the warm allow", async () => {
    const { adapter, counts, release, initializing, stops } = heldAcpAdapter();
    const { agent, subscribed, roomEvents } = await startAgent(adapter, [ROOM_A]);

    const allowing = agent.rooms.allow(ROOM_B, { warm: true });
    await initializing;
    await expect(agent.rooms.deny(ROOM_B)).resolves.toBe(false);
    release();

    await expect(allowing).resolves.toBe(false);
    await stops.until(() => counts.stopped === 1);
    expect(counts).toEqual({ started: 1, stopped: 1 });
    expect(subscribed(ROOM_B)).toBe(false);
    // Nothing is reported for the room, not even room.ready for the start the deny made moot.
    expect(roomEvents(ROOM_B)).toEqual([]);
  });

  it("reports no room.failed when a deny stops a warm start on purpose", async () => {
    const { adapter, release, initializing } = heldAcpAdapter();
    const { agent, reported, roomEvents } = await startAgent(adapter);

    const allowing = agent.rooms.allow(ROOM_B, { warm: true });
    await initializing;
    await expect(agent.rooms.deny(ROOM_B)).resolves.toBe(true);
    release();
    await allowing;
    // Anything reported for B before A's stop has been delivered by then.
    await agent.rooms.deny(ROOM_A);
    await reported("room.stopped", ROOM_A);

    expect(roomEvents(ROOM_B)).toEqual(["room.joined", "room.stopped"]);
  });

  it("dispatches none of a warming room's messages before room.ready, even across a reconnect", async () => {
    const { adapter, release, initializing } = heldAcpAdapter();
    const { agent, platform, reported, roomEvents } = await startAgent(adapter, [ROOM_A]);

    const allowing = agent.rooms.allow(ROOM_B, { warm: true });
    await initializing;
    platform.postBeforeConnect(ROOM_B, "owner", "hello");
    await platform.transport.triggerReconnect({ generation: 1, joinedTopics: new Set(platform.transport.bound.entries) });
    expect(roomEvents(ROOM_B)).toEqual([]);
    release();

    await expect(allowing).resolves.toBe(true);
    await reported("turn.started", ROOM_B);
    expect(roomEvents(ROOM_B).slice(0, 3)).toEqual(["room.ready", "room.joined", "turn.started"]);
  });

  it("does not admit a room denied while start is still joining the rooms before it", async () => {
    const { adapter } = turnRecorder();
    const platform = BandPlatform.host([person("owner")]);
    await platform.room(ROOM_A);
    await platform.room(ROOM_B);
    const { agent, subscribed } = createAgent(adapter, platform);
    const releaseA = platform.transport.gateJoin(chatRoomTopic(ROOM_A));

    const starting = agent.start();
    // Rooms are joined one at a time, so B's join has not begun while A's is held.
    await vi.waitFor(() => expect(platform.transport.joinCalls).toContain(chatRoomTopic(ROOM_A)));
    await expect(agent.rooms.deny(ROOM_B)).resolves.toBe(false);
    releaseA();
    await starting;

    expect(subscribed(ROOM_A)).toBe(true);
    expect(subscribed(ROOM_B)).toBe(false);
  });

  it("starts an admitted room's agent on a warm allow, reporting room.ready and no second join", async () => {
    const { adapter, counts, release } = heldAcpAdapter();
    release();
    const { agent, roomEvents } = await startAgent(adapter);

    await expect(agent.rooms.allow(ROOM_B, { warm: true })).resolves.toBe(true);

    expect(counts.started).toBe(1);
    expect(roomEvents(ROOM_B)).toEqual(["room.joined", "room.ready"]);
  });

  it("resolves false when a deny leaves an admitted room during its warm allow", async () => {
    const { adapter, release, initializing } = heldAcpAdapter();
    const { agent, subscribed } = await startAgent(adapter);

    const allowing = agent.rooms.allow(ROOM_B, { warm: true });
    await initializing;
    await expect(agent.rooms.deny(ROOM_B)).resolves.toBe(true);
    release();

    await expect(allowing).resolves.toBe(false);
    expect(subscribed(ROOM_B)).toBe(false);
  });

  it("admits a warm-allowed room only through the allow, across reconnects during its listing and its start", async () => {
    const { adapter, release, initializing } = heldAcpAdapter();
    const { agent, platform, subscribed, roomEvents } = await startAgent(adapter, [ROOM_A]);
    const listing = holdNextRoomListing(platform);
    const reconnect = (generation: number) =>
      platform.transport.triggerReconnect({ generation, joinedTopics: new Set(platform.transport.bound.entries) });

    const allowing = agent.rooms.allow(ROOM_B, { warm: true });
    await listing.listing;
    await reconnect(1);
    expect(subscribed(ROOM_B)).toBe(false);
    listing.release();
    await initializing;
    await reconnect(2);
    expect(subscribed(ROOM_B)).toBe(false);
    release();

    await expect(allowing).resolves.toBe(true);
    expect(subscribed(ROOM_B)).toBe(true);
    expect(roomEvents(ROOM_B)).toEqual(["room.ready", "room.joined"]);
  });

  it("starts one agent and reports one room.ready and one join for two warm allows of a room at once", async () => {
    const { adapter, counts, release, initializing } = heldAcpAdapter();
    const { agent, roomEvents } = await startAgent(adapter, [ROOM_A]);

    const first = agent.rooms.allow(ROOM_B, { warm: true });
    await initializing;
    const second = agent.rooms.allow(ROOM_B, { warm: true });
    release();

    // The second allow supersedes the first, which leaves the room to it.
    await expect(Promise.all([first, second])).resolves.toEqual([false, true]);
    expect(counts).toEqual({ started: 1, stopped: 0 });
    expect(roomEvents(ROOM_B)).toEqual(["room.ready", "room.joined"]);
  });

  it("admits a member room allowed while start is still joining the rooms before it", async () => {
    const { adapter } = turnRecorder();
    const platform = BandPlatform.host([person("owner")]);
    await platform.room(ROOM_A);
    await platform.room(ROOM_B);
    const { agent, subscribed } = createAgent(adapter, platform, (room) => room.id === ROOM_A);
    const releaseA = platform.transport.gateJoin(chatRoomTopic(ROOM_A));

    const starting = agent.start();
    // Rooms are joined one at a time, so B is not yet decided on while A's join is held.
    await vi.waitFor(() => expect(platform.transport.joinCalls).toContain(chatRoomTopic(ROOM_A)));
    await expect(agent.rooms.allow(ROOM_B)).resolves.toBe(false);
    releaseA();
    await starting;

    expect(subscribed(ROOM_B)).toBe(true);
  });
});
