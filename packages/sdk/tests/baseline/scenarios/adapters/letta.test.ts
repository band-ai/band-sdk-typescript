/**
 * Letta: Band tools reach the server-side agent as client tools, which the
 * adapter runs locally, and the agent keeps its own state on the server:
 * the prior turn and the memory blocks it was built with.
 */
import { ADAPTER, buildLetta } from "../../toolkit/adapters";
import { assertReplyContains } from "../../toolkit/assertMessages";
import { observeRoom } from "../../toolkit/observeMessages";
import { withAdapters } from "../../toolkit/perAdapter";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";
import { uniqueMarker } from "../samples/markers";
import { addsHelperThroughMcp } from "../samples/mcpRoster";

const CODENAME = uniqueMarker("CODENAME");

withAdapters([ADAPTER.letta], scenarioId(CATEGORY.adapters, "letta.clientTools"), async (cast) => {
  await addsHelperThroughMcp(cast);
});

withAdapters(
  [ADAPTER.letta],
  scenarioId(CATEGORY.adapters, "letta.memoryBlocks"),
  async ({ agents: [agent], room }) => {
    await Rooms.sendMention(room, agent!, "What is your codename? Reply with just the codename.");
    assertReplyContains(await observeRoom(room).untilReply(agent!), CODENAME);
  },
  {
    build: (_spec, options) =>
      buildLetta(options, { memoryBlocks: [{ label: "persona", value: `Your codename is ${CODENAME}.` }] }),
  },
);
