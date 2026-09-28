import { assertReplyContains } from "../../toolkit/assertMessages";
import { observeRoom } from "../../toolkit/observeMessages";
import { perAdapter } from "../../toolkit/perAdapter";
import { Rooms } from "../../toolkit/rooms";

perAdapter("platform.repliesToMention", async ({ agent, room }) => {
  await Rooms.sendMention(room, agent, "Reply with the single word: pineapple");
  const reply = await observeRoom(room).untilReply(agent);
  assertReplyContains(reply, "pineapple");
});
