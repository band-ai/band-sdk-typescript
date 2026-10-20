/** A working report from an agent whose runtime runs in the room: Band echoes each state back. */
import { describe, expect, it, onTestFinished } from "vitest";

import { GenericAdapter } from "../../../../src/index";
import { Agents } from "../../toolkit/agents";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { createDeferred } from "../../../../src/core/deferred";
import { ACTIVITY_EVENT, Rooms } from "../../toolkit/rooms";
import { recordSuccessfulWorkingReports } from "../../../support/workingReports";

const SCENARIO = scenarioId(CATEGORY.platform, "workingReport");

const neverReplies = new GenericAdapter(async () => {});

describe(SCENARIO, () => {
  it("automatically starts and stops around a held runtime turn", async () => {
    await using identity = await Agents.provision(SCENARIO, "automatic-worker");
    await using room = await Rooms.create();
    await Rooms.addParticipant(room, identity);
    const entered = createDeferred();
    const release = createDeferred();
    onTestFinished(() => release.resolve());
    const adapter = new GenericAdapter(async ({ tools }) => {
      entered.resolve();
      await release.promise;
      await tools.executeToolCall("band_no_reply", {});
    });
    const reports = recordSuccessfulWorkingReports(identity.rest);
    await using _running = await Agents.runAs(identity, adapter);
    try {
      await Rooms.sendMention(room, identity, "Hold until released, then deliberately finish without a reply.");
      await entered.promise;
      await reports.next((report) => report.roomId === room.id && report.working);
      await room.activity.next((frame) => frame.agentId === identity.id && frame.event === ACTIVITY_EVENT.started);
      // Inbound-message presence also emits frames; require the runtime's successful reports separately.
      const releaseIndex = room.activity.entries.length;
      const reportReleaseIndex = reports.entries.length;
      release.resolve();
      await reports.next((report) => report.roomId === room.id && !report.working, reportReleaseIndex);
      const stopped = await room.activity.next(
        (frame) => frame.agentId === identity.id && frame.event === ACTIVITY_EVENT.stopped,
        releaseIndex,
      );
      expect(room.activity.entries.indexOf(stopped)).toBeGreaterThanOrEqual(releaseIndex);
      expect(room.activity.entries.slice(0, releaseIndex)).toContainEqual(expect.objectContaining({ agentId: identity.id, event: ACTIVITY_EVENT.started }));
    } finally { release.resolve(); }
  });

  it("echoes working, then idle, while the runtime runs in the room", async () => {
    await using identity = await Agents.provision(SCENARIO, "worker");
    await using room = await Rooms.create();
    await Rooms.addParticipant(room, identity);

    await using _running = await Agents.runAs(identity, neverReplies);
    expect(await identity.rest.reportActivity(room.id, true)).toEqual({ working: true });
    expect(await identity.rest.reportActivity(room.id, false)).toEqual({ working: false });
  });
});
