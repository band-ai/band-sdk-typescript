/** After several messages mention the agent, the newest few come back, oldest first. */
import { describe, expect, it } from "vitest";

import { getRecentMessages } from "../../../../src/rest";
import { Agents } from "../../toolkit/agents";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";

const SCENARIO = scenarioId(CATEGORY.platform, "recentMessages");
const SENT = 5;
const NEWEST = 3;

describe(SCENARIO, () => {
  it(`returns the newest ${NEWEST} of ${SENT} mentions, oldest first`, async () => {
    await using identity = await Agents.provision(SCENARIO, "reader");
    await using room = await Rooms.create();
    await Rooms.addParticipant(room, identity);

    const sent: string[] = [];
    for (let index = 1; index <= SENT; index += 1) {
      sent.push((await Rooms.sendMention(room, identity, `message ${index}`)).id);
    }

    const recent = await getRecentMessages(identity.rest, room.id, NEWEST);

    expect(recent.map((message) => message.id)).toEqual(sent.slice(-NEWEST));
  });
});
