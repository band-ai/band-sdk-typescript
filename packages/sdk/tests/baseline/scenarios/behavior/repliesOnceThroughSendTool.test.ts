/**
 * A reply the agent posts through band_send_message is the turn's only reply:
 * the turn's final text, which only narrates that post, is not posted after it.
 */
import { SEND_MESSAGE_TOOL_NAME } from "../../../../src/contracts/toolSchemas";
import { assertDeliveryStatus } from "../../toolkit/assertDelivery";
import { assertReplied, assertReplyContains } from "../../toolkit/assertMessages";
import { DELIVERY_STATUS, observeAgent } from "../../toolkit/observeDelivery";
import { observeRoom } from "../../toolkit/observeMessages";
import { assertToolReply } from "../../toolkit/assertToolReply";
import { scenarioEvidence } from "../../toolkit/scenarioEvidence";
import { perAdapter } from "../../toolkit/perAdapter";
import { CAPABILITY, CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";

const REPLY_WORD = "pineapple";
/** Asks for final text after the send, so every model leaves narration a double post would carry. */
const REQUEST = `Reply with the single word: ${REPLY_WORD}. Send it with ${SEND_MESSAGE_TOOL_NAME}, then say in plain text that you sent it.`;

perAdapter(
  scenarioId(CATEGORY.behavior, "repliesOnceThroughSendTool"),
  async ({ agent, room }) => {
    const evidence = scenarioEvidence(room, agent);
    await evidence.run(async () => {
      const sent = await Rooms.sendMention(room, agent, REQUEST);
      const [reply, delivery] = await Promise.all([
        observeRoom(room).untilReply(agent), observeAgent(agent, room).untilProcessed(sent),
      ]);
      evidence.record({ sent, reply, delivery });
      const stored = await evidence.read();
      assertDeliveryStatus(delivery, DELIVERY_STATUS.processed);
      assertReplied(reply);
      assertReplyContains(reply, REPLY_WORD);
      const recipientId = stored.messages.find((message) => message.id === sent.id)?.senderId;
      if (!recipientId) throw new Error("the request's stored sender is missing");
      assertToolReply(stored.calls, stored.results, stored.replies, { marker: REPLY_WORD, senderId: agent.id, recipientId });
    });
  },
  {
    // The builders that can report the Band tools' calls, which is how the scenario sees the send.
    supports: [CAPABILITY.customTools],
    build: (spec, options) => spec.build({ ...options, reportToolCalls: true }),
  },
);
