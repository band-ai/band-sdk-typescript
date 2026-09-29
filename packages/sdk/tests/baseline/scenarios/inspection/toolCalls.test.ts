/**
 * What an agent's tool calls look like from the room: the stored calls carry
 * the tool's name and arguments, next to the reply they led to and alongside
 * other tools' calls in the same turn. Each request drives opaque tools, so a
 * call is the only way to answer. Every tool-call read follows `untilProcessed`,
 * once the turn's calls are saved; reply text is read only after `untilReply`.
 */
import { assertDeliveryStatus } from "../../toolkit/assertDelivery";
import { assertReplyContains, assertToolFired } from "../../toolkit/assertMessages";
import { DELIVERY_STATUS, observeAgent } from "../../toolkit/observeDelivery";
import { observeRoom, toolCalls } from "../../toolkit/observeMessages";
import { perAdapter } from "../../toolkit/perAdapter";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";
import {
  FORECAST_TOOL,
  KEY,
  LOOKUP_TOOL,
  PLACE,
  WITH_LOOKUP,
  WITH_LOOKUP_AND_FORECAST,
  codeFor,
  lookupAndForecastRequest,
  lookupRequest,
} from "../samples/lookupTool";
import { takeTurn } from "../samples/turns";

perAdapter(
  scenarioId(CATEGORY.inspection, "toolCalls.firedWithArgs"),
  async ({ agent, room }) => {
    await takeTurn(room, agent, lookupRequest(KEY.alpha));

    assertToolFired(await toolCalls(room, agent), LOOKUP_TOOL.name, { key: KEY.alpha });
  },
  WITH_LOOKUP,
);

perAdapter(
  scenarioId(CATEGORY.inspection, "toolCalls.replyAndToolCalls"),
  async ({ agent, room }) => {
    const sent = await Rooms.sendMention(room, agent, lookupRequest(KEY.beta));

    // The code is the tool's secret, so the reply can only carry it after the call.
    assertReplyContains(await observeRoom(room).untilReply(agent), codeFor(KEY.beta));
    assertDeliveryStatus(await observeAgent(agent, room).untilProcessed(sent), DELIVERY_STATUS.processed);

    assertToolFired(await toolCalls(room, agent), LOOKUP_TOOL.name, { key: KEY.beta });
  },
  WITH_LOOKUP,
);

perAdapter(
  scenarioId(CATEGORY.inspection, "toolCalls.multipleToolsInOneTurn"),
  async ({ agent, room }) => {
    await takeTurn(room, agent, lookupAndForecastRequest(KEY.alpha, PLACE));

    const calls = await toolCalls(room, agent);
    assertToolFired(calls, LOOKUP_TOOL.name, { key: KEY.alpha });
    assertToolFired(calls, FORECAST_TOOL.name, { place: PLACE });
  },
  WITH_LOOKUP_AND_FORECAST,
);
