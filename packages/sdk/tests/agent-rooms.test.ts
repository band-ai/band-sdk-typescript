import type { Agent as AcpAgent } from "@agentclientprotocol/sdk";
import { chatRoomTopic } from "@band-ai/band-sdk-core";
import { describe, expect, it, onTestFinished } from "vitest";

import { ACPClientAdapter } from "../src/adapters/acp";
import { GenericAdapter } from "../src/adapters/GenericAdapter";
import { Agent } from "../src/agent/Agent";
import type { FrameworkAdapter } from "../src/contracts/protocols";
import type { AgentEvent } from "../src/contracts/events";
import { BandLink } from "../src/platform/BandLink";
import { AGENT_API_KEY, AGENT_ID, BandPlatform, person } from "./flows/support/bandPlatform";
import { inMemoryAgent } from "./support/inMemoryAcpAgent";
import { tmpRoot } from "./testUtils";

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

/** An agent on a platform that has it in rooms A and B; `roomFilter` admits only `admit` at start. */
async function startAgent(adapter: FrameworkAdapter, admit: readonly string[] = [ROOM_A, ROOM_B]) {
  const platform = BandPlatform.host([person("owner")]);
  const roomA = await platform.room(ROOM_A);
  const roomB = await platform.room(ROOM_B);
  const agent = Agent.create({
    adapter,
    agentId: AGENT_ID,
    apiKey: AGENT_API_KEY,
    link: new BandLink({ agentId: AGENT_ID, apiKey: AGENT_API_KEY, ...platform.link }),
    roomFilter: (room) => admit.includes(String(room.id)),
  });
  const events: AgentEvent[] = [];
  agent.observe((event) => {
    events.push(event);
  });
  await agent.start();
  onTestFinished(async () => {
    if (agent.isRunning) await agent.stop();
  });
  const subscribed = (roomId: string) => platform.transport.hasTopic(chatRoomTopic(roomId));
  const roomEvents = (roomId: string) =>
    events.filter((event) => "roomId" in event && event.roomId === roomId).map((event) => event.type);
  return { agent, platform, roomA, roomB, events, subscribed, roomEvents };
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

  it("leaves a room on deny: no more turns, and its topic is dropped", async () => {
    const { adapter, turns } = turnRecorder();
    const { agent, platform, roomA, subscribed, roomEvents } = await startAgent(adapter);
    expect(subscribed(ROOM_B)).toBe(true);

    await expect(agent.rooms.deny(ROOM_B)).resolves.toBe(true);

    expect(subscribed(ROOM_B)).toBe(false);
    expect(roomEvents(ROOM_B)).toEqual(["room.joined", "room.stopped", "room.left"]);
    // Band announcing the room again does not bring it back.
    await platform.room(ROOM_B);
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

    await platform.room("room-c");
    await platform.room("room-d");
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

  it("starts a warm room's agent and reports room.ready before the room takes any message", async () => {
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
});
