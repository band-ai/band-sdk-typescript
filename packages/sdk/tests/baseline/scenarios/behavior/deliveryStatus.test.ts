/**
 * The per-recipient delivery lifecycle, from the platform's real
 * `message_updated` states: every adapter's healthy turn passes through
 * `processing` and ends `processed`, and an agent whose turn throws, or ends
 * without a reply, drives a real `failed`.
 */
import { missingReplyMessage } from "@band-ai/band-sdk-core";
import { describe, expect, it } from "vitest";

import { GenericAdapter } from "../../../../src/index";
import { Agents } from "../../toolkit/agents";
import { assertDeliveryStatus } from "../../toolkit/assertDelivery";
import { assertReplied } from "../../toolkit/assertMessages";
import { DELIVERY_STATUS, observeAgent } from "../../toolkit/observeDelivery";
import { eventsFrom, MESSAGE_TYPE, observeRoom } from "../../toolkit/observeMessages";
import { perAdapter } from "../../toolkit/perAdapter";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";

const SCENARIO = scenarioId(CATEGORY.behavior, "deliveryStatus");
const TURN_ERROR = "this turn fails on purpose";

perAdapter(SCENARIO, async ({ agent, room }) => {
  const sent = await Rooms.sendMention(room, agent, "Say hi.");
  // Independent frames: the reply and the processed state each need their own wait.
  assertReplied(await observeRoom(room).untilReply(agent));
  const delivery = observeAgent(agent, room);
  assertDeliveryStatus(await delivery.untilProcessed(sent), DELIVERY_STATUS.processed);

  expect(delivery.history(sent), "the healthy lifecycle").toEqual([DELIVERY_STATUS.processing, DELIVERY_STATUS.processed]);
});

const alwaysFails = new GenericAdapter(async () => {
  throw new Error(TURN_ERROR);
});

const neverReplies = new GenericAdapter(async () => {});

describe(SCENARIO, () => {
  it("marks a message failed when the agent's turn throws", async () => {
    await using identity = await Agents.provision(SCENARIO, "failing");
    await using room = await Rooms.create();
    await Rooms.addParticipant(room, identity);
    await using _running = await Agents.runAs(identity, alwaysFails);

    const sent = await Rooms.sendMention(room, identity, "This will fail.");
    const delivery = observeAgent(identity, room);
    const state = await delivery.untilStatus(sent, DELIVERY_STATUS.failed);

    assertDeliveryStatus(state, DELIVERY_STATUS.failed);
    expect(state.error).toContain(TURN_ERROR);
    expect(delivery.history(sent)).toContain(DELIVERY_STATUS.failed);
  });

  it("marks a message failed and reports core's missing reply once when the turn ends without a reply", async () => {
    await using identity = await Agents.provision(SCENARIO, "silent");
    await using room = await Rooms.create();
    await Rooms.addParticipant(room, identity);
    await using _running = await Agents.runAs(identity, neverReplies);

    const sent = await Rooms.sendMention(room, identity, "This gets no answer.");
    const delivery = observeAgent(identity, room);
    assertDeliveryStatus(await delivery.untilStatus(sent, DELIVERY_STATUS.failed), DELIVERY_STATUS.failed);

    const reported = await eventsFrom(room, MESSAGE_TYPE.Error, identity);
    expect(reported.map((event) => event.content)).toEqual([missingReplyMessage()]);
    expect(await eventsFrom(room, MESSAGE_TYPE.Text, identity)).toEqual([]);
  });
});
