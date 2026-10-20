import { describe, expect, it } from "vitest";
import { FakePhoenixPeer } from "./fakePhoenixPeer";
import { PhoenixChannelsTransport } from "../src/platform/streaming/PhoenixChannelsTransport";
import { ACTIVITY_EVENT, Room } from "./baseline/toolkit/rooms";

describe("baseline activity observer", () => {
  it("normalizes starts, replaces changes and removes stopped executions while retaining raw extensions", async () => {
    await using peer = await FakePhoenixPeer.start();
    const transport = new PhoenixChannelsTransport({ wsUrl: peer.url, apiKey: "observer" });
    try {
      const room = await Room.observing("room", transport);
      const send = async (event: typeof ACTIVITY_EVENT[keyof typeof ACTIVITY_EVENT], detail: Record<string, unknown> = {}) => {
        const from = room.activity.entries.length;
        peer.push("room_activity:room", event, { agent_id: "agent", execution_id: "execution", server_extension: "retained", ...detail });
        return await room.activity.next(() => true, from);
      };
      expect((await send(ACTIVITY_EVENT.started)).activity).toEqual({ kind: "reasoning" });
      const tool = await send(ACTIVITY_EVENT.changed, { activity: { kind: "tool_call", name: "lookup", additive: true } });
      expect(tool.activity).toEqual({ kind: "tool_call", name: "lookup" });
      expect(tool.raw).toMatchObject({ server_extension: "retained", activity: { additive: true } });
      expect(room.activityByExecution.get("execution")).toBe(tool);
      expect((await send(ACTIVITY_EVENT.stopped)).activity).toBeUndefined();
      expect(room.activityByExecution.has("execution")).toBe(false);
      expect((await send(ACTIVITY_EVENT.started, { activity: { kind: "memory" } })).activity).toEqual({ kind: "memory" });
    } finally {
      await transport.disconnect();
    }
  });
});
