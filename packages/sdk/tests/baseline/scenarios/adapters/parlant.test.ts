/**
 * Parlant: the steering prompt reaches the model. Parlant takes no system
 * messages, so the prompt travels as the description of the agent the
 * adapter creates.
 */
import { ADAPTER } from "../../toolkit/adapters";
import { assertReplyContains } from "../../toolkit/assertMessages";
import { observeRoom } from "../../toolkit/observeMessages";
import { withAdapters } from "../../toolkit/perAdapter";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";
import { uniqueMarker } from "../samples/markers";

const SIGN_OFF = uniqueMarker("SIGNOFF");

withAdapters(
  [ADAPTER.parlant],
  scenarioId(CATEGORY.adapters, "parlant.systemPrompt"),
  async ({ agents: [agent], room }) => {
    await Rooms.sendMention(room, agent!, "Please say hello.");
    assertReplyContains(await observeRoom(room).untilReply(agent!), SIGN_OFF);
  },
  { prompt: `End every reply with ${SIGN_OFF}.` },
);
