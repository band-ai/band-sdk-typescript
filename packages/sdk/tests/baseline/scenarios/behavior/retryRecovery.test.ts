/**
 * A message the agent can never handle is marked permanently failed, not
 * retried forever. Retries are counted only when startup recovery replays the
 * backlog, so the message is posted before the agent starts, and
 * `maxMessageRetries: 0` exhausts it on that first replay.
 */
import { describe, expect, it } from "vitest";

import { GenericAdapter } from "../../../../src/index";
import { PERMANENT_FAILURE_ERROR } from "../../../../src/runtime/Execution";
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
  it("marks a backlog message failed once its retries are exhausted", async () => {
    await using identity = await Agents.provision(SCENARIO, "agent");
    await using room = await Rooms.create();
    await Rooms.addParticipant(room, identity);
    const seeded = await Rooms.sendMention(room, identity, "this must permanently fail on the first recovery attempt");

    await using _running = await Agents.runAs(identity, neverRuns, { sessionConfig: { maxMessageRetries: NO_RETRIES } });
    const state = await observeAgent(identity, room).untilStatus(seeded, DELIVERY_STATUS.failed);

    assertDeliveryStatus(state, DELIVERY_STATUS.failed);
    expect(state.error).toBe(PERMANENT_FAILURE_ERROR);
  });
});
