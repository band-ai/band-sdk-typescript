/**
 * A message the agent can never handle is given up on, not retried forever.
 * Band has no give-up state: a failed message stays the head of
 * `/messages/next`, so giving up marks it processed. Retries are counted only
 * when startup recovery replays the backlog, so the message is posted before
 * the agent starts, and `maxMessageRetries: 0` exhausts it on that first replay.
 */
import { describe, it } from "vitest";

import { GenericAdapter } from "../../../../src/index";
import { Agents } from "../../toolkit/agents";
import { assertDeliveryStatus } from "../../toolkit/assertDelivery";
import { DELIVERY_STATUS, observeAgent } from "../../toolkit/observeDelivery";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";

const SCENARIO = scenarioId(CATEGORY.behavior, "retryRecovery");
/** No retries: the first recovery replay exhausts the message. */
const NO_RETRIES = 0;

const neverRuns = new GenericAdapter(async () => {
  throw new Error("this adapter must never run: maxMessageRetries 0 exhausts the message before it is called");
});

describe(SCENARIO, () => {
  it("gives up on a backlog message once its retries are exhausted, taking it off /messages/next", async () => {
    await using identity = await Agents.provision(SCENARIO, "agent");
    await using room = await Rooms.create();
    await Rooms.addParticipant(room, identity);
    const seeded = await Rooms.sendMention(room, identity, "this must permanently fail on the first recovery attempt");

    await using _running = await Agents.runAs(identity, neverRuns, { sessionConfig: { maxMessageRetries: NO_RETRIES } });
    const state = await observeAgent(identity, room).untilProcessed(seeded);

    assertDeliveryStatus(state, DELIVERY_STATUS.processed);
  });
});
