/**
 * The processing barrier holds under a burst. A room handles its messages one
 * at a time, in order, so two messages sent back to back queue behind each
 * other; waiting on the last one's `processed` state must then imply the first
 * is processed too. That transitivity is what makes waiting on one message
 * valid. No reply is asserted: `processed` marks the end of the turn, and a
 * bare "remember this" needs no reply.
 */
import { NO_REPLY_TOOL_NAME } from "../../../../src/contracts/toolSchemas";
import { assertDeliveryStatus } from "../../toolkit/assertDelivery";
import { DELIVERY_STATUS, observeAgent } from "../../toolkit/observeDelivery";
import { perAdapter } from "../../toolkit/perAdapter";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";

/** Repeated, so a barrier that only sometimes holds is caught. */
const ROUNDS = 4;

/**
 * The shared steering prompt tells the agent to answer every message. These
 * turns are notes, not questions, so that instruction would make each one a
 * reply. Decline instead, the same rule the send tool already states.
 */
const PROMPT =
  "You are a helpful assistant in a chat room. When someone asks you a question or asks you to do something, reply to them directly and briefly. " +
  `When a message only tells you something to keep in mind and does not ask a question, it needs no answer: call ${NO_REPLY_TOOL_NAME} and do not post a message.`;

perAdapter(
  scenarioId(CATEGORY.behavior, "processingBarrier"),
  async ({ agent, room }) => {
    const delivery = observeAgent(agent, room);
    for (let round = 0; round < ROUNDS; round += 1) {
      // No wait between them, so the second queues behind the first.
      const first = await Rooms.sendMention(room, agent, "Remember: my favorite color is teal.");
      const last = await Rooms.sendMention(room, agent, "Also remember: my dog is named Pixel.");

      const label = `round ${round}`;
      assertDeliveryStatus(await delivery.untilProcessed(last), DELIVERY_STATUS.processed, label);
      assertDeliveryStatus(delivery.status(first), DELIVERY_STATUS.processed, `${label}: the last message is processed, so the first must be`);
    }
  },
  { prompt: PROMPT },
);
