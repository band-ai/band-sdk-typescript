/**
 * Tool trajectories don't mix: a room's stored tool calls, read per sender,
 * hold only that sender's calls; one agent's calls in two rooms stay in their
 * own room; and a turn's calls are told apart from an earlier turn's. Each
 * request drives an opaque lookup with a distinct key, so a leak shows as a
 * key where it doesn't belong. Every read follows `untilProcessed`, once the
 * turn's tool calls are saved.
 */
import { expect } from "vitest";

import type { AgentIdentity } from "../../toolkit/agents";
import { assertDeliveryStatus } from "../../toolkit/assertDelivery";
import { DELIVERY_STATUS, observeAgent } from "../../toolkit/observeDelivery";
import { perAdapter } from "../../toolkit/perAdapter";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms, type Room } from "../../toolkit/rooms";
import { KEY, WITH_LOOKUP, lookupCalls, lookupRequest } from "../samples/lookupTool";

/** Asks `agent` to look up `key` in `room` and waits until that turn is done. */
async function lookUp(room: Room, agent: AgentIdentity, key: string): Promise<void> {
  const sent = await Rooms.sendMention(room, agent, lookupRequest(key));
  assertDeliveryStatus(await observeAgent(agent, room).untilProcessed(sent), DELIVERY_STATUS.processed);
}

const keysOf = async (room: Room, sender: AgentIdentity) => (await lookupCalls(room, sender)).map((call) => call.key);

perAdapter(
  scenarioId(CATEGORY.behavior, "isolation.perSender"),
  async ({ agent, room, cell }) => {
    await using other = await cell.running("other");
    await Rooms.addParticipant(room, other.identity);

    await lookUp(room, agent, KEY.alpha);
    await lookUp(room, other.identity, KEY.beta);

    const [agentKeys, otherKeys] = await Promise.all([keysOf(room, agent), keysOf(room, other.identity)]);
    expect(agentKeys, "the first agent's calls").toEqual([KEY.alpha]);
    expect(otherKeys, "the other agent's calls").toEqual([KEY.beta]);
  },
  WITH_LOOKUP,
);

perAdapter(
  scenarioId(CATEGORY.behavior, "isolation.perRoom"),
  async ({ agent, room }) => {
    await using second = await Rooms.create();
    await Rooms.addParticipant(second, agent);

    await Promise.all([lookUp(room, agent, KEY.alpha), lookUp(second, agent, KEY.beta)]);

    const [firstKeys, secondKeys] = await Promise.all([keysOf(room, agent), keysOf(second, agent)]);
    expect(firstKeys, "the first room's calls").toEqual([KEY.alpha]);
    expect(secondKeys, "the second room's calls").toEqual([KEY.beta]);
  },
  WITH_LOOKUP,
);

perAdapter(
  scenarioId(CATEGORY.behavior, "isolation.perTurn"),
  async ({ agent, room }) => {
    await lookUp(room, agent, KEY.alpha);
    const earlier = new Set((await lookupCalls(room, agent)).map((call) => call.id));

    await lookUp(room, agent, KEY.beta);
    const calls = await lookupCalls(room, agent);

    expect(calls.map((call) => call.key), "the room holds both turns' calls").toEqual([KEY.alpha, KEY.beta]);
    expect(
      calls.filter((call) => !earlier.has(call.id)).map((call) => call.key),
      "the second turn's calls, told apart from the first's",
    ).toEqual([KEY.beta]);
  },
  WITH_LOOKUP,
);
