/**
 * A reply the agent posts through band_send_message is the turn's only reply:
 * the turn's final text, which only narrates that post, is not posted after it.
 */
import { expect } from "vitest";

import { SEND_MESSAGE_TOOL_NAME } from "../../../../src/contracts/toolSchemas";
import { assertDeliveryStatus } from "../../toolkit/assertDelivery";
import { assertReplied, assertReplyContains } from "../../toolkit/assertMessages";
import { DELIVERY_STATUS, observeAgent } from "../../toolkit/observeDelivery";
import { MESSAGE_TYPE, observeRoom, toolCalls } from "../../toolkit/observeMessages";
import { perAdapter } from "../../toolkit/perAdapter";
import { CAPABILITY, CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";

const REPLY_WORD = "pineapple";
/** Asks for final text after the send, so every model leaves narration a double post would carry. */
const REQUEST = `Reply with the single word: ${REPLY_WORD}. Send it with ${SEND_MESSAGE_TOOL_NAME}, then say in plain text that you sent it.`;

perAdapter(
  scenarioId(CATEGORY.behavior, "repliesOnceThroughSendTool"),
  async ({ agent, room }) => {
    const sent = await Rooms.sendMention(room, agent, REQUEST);
    const reply = await observeRoom(room).untilReply(agent);
    assertReplied(reply);
    assertReplyContains(reply, REPLY_WORD);
    // Every post lands before the turn is marked processed, so the stored history is complete here.
    assertDeliveryStatus(await observeAgent(agent, room).untilProcessed(sent), DELIVERY_STATUS.processed);

    const called = (await toolCalls(room, agent)).map((call) => call.name);
    expect(called, "the agent replied through the Band tool").toContain(SEND_MESSAGE_TOOL_NAME);
    const replies = (await observeRoom(room).history(MESSAGE_TYPE.Text)).filter((message) => message.senderId === agent.id);
    expect(replies.map((message) => message.content), "the agent's room messages").toEqual([reply.message.content]);
  },
  {
    // The builders that can report the Band tools' calls, which is how the scenario sees the send.
    supports: [CAPABILITY.customTools],
    build: (spec, options) => spec.build({ ...options, reportToolCalls: true }),
  },
);
