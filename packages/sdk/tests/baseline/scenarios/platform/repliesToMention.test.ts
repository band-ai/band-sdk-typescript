import { assertReplyContains } from "../../toolkit/assertMessages";
import { observeRoom } from "../../toolkit/observeMessages";
import { perAdapter } from "../../toolkit/perAdapter";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";

/** The one word the agent is asked to reply with, and the reply is checked for. */
const REPLY_WORD = "pineapple";

perAdapter(scenarioId(CATEGORY.platform, "repliesToMention"), async ({ agent, room }) => {
  await Rooms.sendMention(room, agent, `Reply with the single word: ${REPLY_WORD}`);
  const reply = await observeRoom(room).untilReply(agent);
  assertReplyContains(reply, REPLY_WORD);
});
