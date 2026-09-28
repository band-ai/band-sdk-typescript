/**
 * The processing barrier holds under a burst. A room handles its messages one
 * at a time, in order, so two messages sent back to back queue behind each
 * other; waiting on the last one's `processed` state must then imply the first
 * is processed too. That transitivity is what makes waiting on one message
 * valid. No reply is asserted: `processed` marks the end of the turn, and a
 * bare "remember this" needs no reply.
 */
import { expect } from "vitest";

import { assertDeliveryStatus } from "../../toolkit/assertDelivery";
import { DELIVERY_STATUS, observeAgent } from "../../toolkit/observeDelivery";
import { perAdapter } from "../../toolkit/perAdapter";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";

/** Repeated, so a barrier that only sometimes holds is caught. */
const ROUNDS = 4;

perAdapter(scenarioId(CATEGORY.behavior, "processingBarrier"), async ({ agent, room }) => {
  const delivery = observeAgent(agent, room);
  for (let round = 0; round < ROUNDS; round += 1) {
    // No wait between them, so the second queues behind the first.
    const first = await Rooms.sendMention(room, agent, "Remember: my favorite color is teal.");
    const last = await Rooms.sendMention(room, agent, "Also remember: my dog is named Pixel.");

    assertDeliveryStatus(await delivery.untilProcessed(last), DELIVERY_STATUS.processed);
    expect(delivery.status(first).status, `round ${round}: the last message is processed, so the first must be`).toBe(
      DELIVERY_STATUS.processed,
    );
  }
});
