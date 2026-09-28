/**
 * Across turns, an agent answers only the new request: it must remember its own
 * earlier replies, or each turn looks like every earlier request is still
 * unanswered and it answers them all again.
 */
import { expect } from "vitest";

import { assertDeliveryStatus } from "../../toolkit/assertDelivery";
import { assertReplyContains } from "../../toolkit/assertMessages";
import { DELIVERY_STATUS, observeAgent } from "../../toolkit/observeDelivery";
import { MESSAGE_TYPE, observeRoom } from "../../toolkit/observeMessages";
import { perAdapter } from "../../toolkit/perAdapter";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";

/** One distinct word per turn, each asked for once. */
const WORDS = ["pineapple", "mango", "kiwi"] as const;

perAdapter(scenarioId(CATEGORY.behavior, "remembersItsReplies"), async ({ agent, room }) => {
  const answered = new Set<string>();
  /** The agent's replies since the last call. */
  const newReplies = async () => {
    const replies = (await observeRoom(room).history(MESSAGE_TYPE.Text)).filter(
      (message) => message.senderId === agent.id && !answered.has(message.id),
    );
    replies.forEach((reply) => answered.add(reply.id));
    return replies;
  };

  for (const [turn, word] of WORDS.entries()) {
    const sent = await Rooms.sendMention(room, agent, `Reply with the single word: ${word}`);
    assertReplyContains(await observeRoom(room).untilReply(agent), word);
    // The next request goes in only once this turn is done, so each is its own turn.
    assertDeliveryStatus(await observeAgent(agent, room).untilProcessed(sent), DELIVERY_STATUS.processed);

    const earlier = WORDS.slice(0, turn);
    const reanswers = (await newReplies()).filter((reply) => earlier.some((done) => reply.content.toLowerCase().includes(done)));
    expect(reanswers.map((reply) => reply.content), `the "${word}" turn re-answered an earlier request`).toEqual([]);
  }
});
