/** A room the agent creates with a title shows it, a rename replaces it, and Band refuses a title with a newline. */
import { describe, expect, it } from "vitest";

import { Agents } from "../../toolkit/agents";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";
import { uniqueMarker } from "../samples/markers";

const SCENARIO = scenarioId(CATEGORY.platform, "titledRooms");
const UNPROCESSABLE = 422;

describe(SCENARIO, () => {
  it("shows the title a room was created with, then its new one, and refuses a newline", async () => {
    await using identity = await Agents.provision(SCENARIO, "owner");
    const title = uniqueMarker("feature room ");
    const renamed = uniqueMarker("renamed room ");

    await using room = await Rooms.createAs(identity, { title });
    expect((await identity.rest.getChat(room.id)).title).toBe(title);

    await identity.rest.renameChat(room.id, renamed);
    expect((await identity.rest.getChat(room.id)).title).toBe(renamed);

    await expect(Rooms.createAs(identity, { title: `${title}\nsecond line` })).rejects.toMatchObject({ statusCode: UNPROCESSABLE });
  });
});
