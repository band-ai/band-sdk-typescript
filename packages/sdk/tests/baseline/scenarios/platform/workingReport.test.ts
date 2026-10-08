/** A working report from an agent whose runtime runs in the room: Band echoes each state back. */
import { describe, expect, it } from "vitest";

import { GenericAdapter } from "../../../../src/index";
import { Agents } from "../../toolkit/agents";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";

const SCENARIO = scenarioId(CATEGORY.platform, "workingReport");

const neverReplies = new GenericAdapter(async () => {});

describe(SCENARIO, () => {
  it("echoes working, then idle, while the runtime runs in the room", async () => {
    await using identity = await Agents.provision(SCENARIO, "worker");
    await using room = await Rooms.create();
    await Rooms.addParticipant(room, identity);

    await using _running = await Agents.runAs(identity, neverReplies);
    expect(await identity.rest.reportActivity(room.id, true)).toEqual({ working: true });
    expect(await identity.rest.reportActivity(room.id, false)).toEqual({ working: false });
  });
});
