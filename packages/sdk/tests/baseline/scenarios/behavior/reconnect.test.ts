/**
 * A real socket drop mid-session doesn't strand the room: the transport's own
 * reconnect rejoins every channel, and a message sent after the drop is still
 * answered. The transport's reconnect notification is the structural proof the
 * reconnect path ran. The runtime has no idle REST re-poll, so an answer after
 * the drop can only come through the rejoined channels or the reconnect's own
 * sync. A transport concern, not an adapter one, so the agent just echoes.
 */
import { describe, expect, it } from "vitest";

import { GenericAdapter } from "../../../../src/index";
import { Agents, type AgentIdentity } from "../../toolkit/agents";
import { assertReplyContains } from "../../toolkit/assertMessages";
import { DroppableTransport } from "../../toolkit/droppableTransport";
import { observeRoom } from "../../toolkit/observeMessages";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms, type Room } from "../../toolkit/rooms";
import { uniqueMarker } from "../samples/markers";

const SCENARIO = scenarioId(CATEGORY.behavior, "reconnect");

const echoes = new GenericAdapter(async ({ message, tools }) => {
  await tools.sendMessage(message.content, [{ id: message.senderId }]);
});

/** Sends a fresh marker and fails unless the agent answers with it. */
async function answersProbe(room: Room, agent: AgentIdentity, label: string): Promise<void> {
  const marker = uniqueMarker(label);
  await Rooms.sendMention(room, agent, marker);
  assertReplyContains(await observeRoom(room).untilReply(agent), marker);
}

describe(SCENARIO, () => {
  it("keeps the room working across a real transport drop", async () => {
    await using identity = await Agents.provision(SCENARIO, "agent");
    await using room = await Rooms.create();
    await Rooms.addParticipant(room, identity);
    const link = await DroppableTransport.create(identity);
    await using _running = await Agents.runAs(identity, echoes, { transport: link.transport });

    await answersProbe(room, identity, "before");

    const reconnect = await link.dropAndReconnect();
    expect(reconnect.joinedTopics, "every channel rejoined").toEqual(reconnect.attemptedTopics);

    await answersProbe(room, identity, "after");
  });
});
