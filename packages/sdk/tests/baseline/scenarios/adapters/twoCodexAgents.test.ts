/**
 * Agent-to-agent traffic reaches a Codex agent: another agent in the room asks
 * it a question, and Codex answers in the room.
 */
import { ADAPTER } from "../../toolkit/adapters";
import { assertReplyContains } from "../../toolkit/assertMessages";
import { observeRoom } from "../../toolkit/observeMessages";
import { withAdapters } from "../../toolkit/perAdapter";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";

const QUESTION = "What is 2+2? Reply with just the number.";
const ANSWER = "4";

withAdapters([ADAPTER.codex], scenarioId(CATEGORY.adapters, "twoCodexAgents"), async ({ agents: [codex], room, cells: [cell] }) => {
  await using planner = await cell!.provision("planner");
  await Rooms.addParticipant(room, planner);

  await Rooms.sendMention(room, codex!, QUESTION, { from: planner });
  assertReplyContains(await observeRoom(room).untilReply(codex!), ANSWER);
});
