import { describe, expect, it } from "vitest";
import { GenericAdapter } from "../src/adapters/GenericAdapter";
import { createDeferred } from "../src/core/deferred";
import { BandLink } from "../src/platform/BandLink";
import { PhoenixChannelsTransport } from "../src/platform/streaming/PhoenixChannelsTransport";
import { PlatformRuntime } from "../src/runtime/PlatformRuntime";
import { ACTIVITY_EVENT, Room } from "./baseline/toolkit/rooms";
import { FakePhoenixPeer } from "./fakePhoenixPeer";
import { buildFakeRestAdapter } from "./support/fakeRestAdapter";
import { recordSuccessfulWorkingReports } from "./support/workingReports";
import { FakeRestApi, FakeTransport, makeMessage } from "./testUtils";

describe("automatic working-report acceptance", () => {
  it.each([false, true])("requires successful runtime reports despite inbound presence (enabled: %s)", async (enabled) => {
    const peer = await FakePhoenixPeer.start();
    const observer = new PhoenixChannelsTransport({ wsUrl: peer.url, apiKey: "observer" });
    // Keep the real Room observer; only live provisioning and cleanup are replaced by this local peer.
    const room = await Room.observing("room", observer);
    const entered = createDeferred();
    const release = createDeferred();
    const generated = buildFakeRestAdapter([
      { status: 200, body: { data: { working: true } } },
      { status: 200, body: { data: { working: true } } },
      { status: 200, body: { data: { working: true } } },
      { status: 200, body: { data: { working: false } } },
    ]);
    const reports = recordSuccessfulWorkingReports(generated.rest);
    const rest = Object.assign(new FakeRestApi({}, { id: "a1", name: "Agent", description: null }), {
      reportActivity: generated.rest.reportActivity.bind(generated.rest),
    });
    const runtime = new PlatformRuntime({
      agentId: "a1", apiKey: "k", sessionConfig: { enableWorkingState: enabled },
      link: new BandLink({ agentId: "a1", apiKey: "k", restApi: rest, transport: new FakeTransport() }),
    });
    try {
      await runtime.start(new GenericAdapter(async ({ tools }) => {
        entered.resolve();
        await release.promise;
        await tools.executeToolCall("band_no_reply", {});
      }));
      const run = runtime.bootstrapRoomMessage(room.id, { ...makeMessage("hold"), roomId: room.id });
      await entered.promise;
      peer.push("room_activity:room", ACTIVITY_EVENT.started, { agent_id: "a1", execution_id: "inbound", working: true });
      await room.activity.next((frame) => frame.agentId === "a1" && frame.event === ACTIVITY_EVENT.started);
      const releaseIndex = room.activity.entries.length;
      const reportReleaseIndex = reports.entries.length;
      release.resolve();
      peer.push("room_activity:room", ACTIVITY_EVENT.stopped, { agent_id: "a1", execution_id: "inbound", working: false });
      const stopped = await room.activity.next(
        (frame) => frame.agentId === "a1" && frame.event === ACTIVITY_EVENT.stopped, releaseIndex,
      );
      await run;
      expect(room.activity.entries.indexOf(stopped)).toBeGreaterThanOrEqual(releaseIndex);
      expect(room.activity.entries.slice(0, releaseIndex)).toContainEqual(expect.objectContaining({ agentId: "a1", event: ACTIVITY_EVENT.started }));
      if (enabled) {
        expect(reports.entries.slice(0, reportReleaseIndex)).toContainEqual({ roomId: room.id, working: true });
        expect(reports.entries.slice(reportReleaseIndex)).toContainEqual({ roomId: room.id, working: false });
        // A report queued behind an in-flight one is dropped once its scope ends, so only the endpoint is fixed.
        expect(new Set(generated.calls.map(({ method, url }) => `${method} ${url}`)))
          .toEqual(new Set(["POST http://fake-band.test/api/v1/agent/chats/room/activity"]));
      } else {
        // Both original observer checks passed, but neither required successful report exists.
        expect(reports.entries).toEqual([]);
        expect(generated.calls).toEqual([]);
      }
    } finally {
      release.resolve();
      await runtime.stop(0);
      await observer.disconnect();
      await peer.stop();
    }
  });

  it("does not count a failed generated HTTP report as successful", async () => {
    const { rest, calls } = buildFakeRestAdapter([{ status: 404, body: { error: "no execution" } }]);
    const reports = recordSuccessfulWorkingReports(rest);
    await expect(rest.reportActivity("room", true)).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(reports.entries).toEqual([]);
  });
});
