import { chatRoomTopic } from "@band-ai/band-sdk-core";
import { describe, expect, it } from "vitest";

import { BandLink } from "../src/platform/BandLink";
import { AgentRuntime } from "../src/runtime/rooms/AgentRuntime";
import { AGENT_API_KEY, AGENT_ID, BandPlatform, person } from "./flows/support/bandPlatform";
import { RecordLog } from "./testUtils";

describe("AgentRuntime room callbacks", () => {
  it("reports a room joined while the runtime stops, so its leave has a join", async () => {
    const platform = BandPlatform.host([person("owner")]);
    await platform.room("room-a");
    const joined = new RecordLog<string>();
    const left = new RecordLog<string>();
    const handled = new RecordLog<string>();
    const runtime = new AgentRuntime({
      link: new BandLink({ agentId: AGENT_ID, apiKey: AGENT_API_KEY, ...platform.link }),
      agentId: AGENT_ID,
      onExecute: async (context) => {
        handled.record(context.roomId);
      },
      onRoomJoined: (roomId) => joined.record(roomId),
      onRoomLeft: (roomId) => left.record(roomId),
    });
    await runtime.start();
    // Band adds the agent to room-b; its join is in flight when the runtime stops.
    const releaseB = platform.transport.gateJoin(chatRoomTopic("room-b"));
    const roomB = await platform.room("room-b");
    roomB.postBeforeConnect("owner", "waiting in B");
    await platform.transport.joining.next((topic) => topic === chatRoomTopic("room-b"));
    const stopping = runtime.stop();
    expect(runtime.state.status).toBe("stopping");

    releaseB();
    await stopping;

    expect(joined.entries).toEqual(["room-a", "room-b"]);
    expect(left.entries.filter((roomId) => !joined.entries.includes(roomId))).toEqual([]);
    // The stop owned room-b: its join started no turn-taking there.
    expect(handled.entries).not.toContain("room-b");
  });
});
