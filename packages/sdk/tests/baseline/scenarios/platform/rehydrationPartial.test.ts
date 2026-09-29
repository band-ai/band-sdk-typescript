/**
 * Rebooter cycles through two cold runs while a stayer stays up; run 2 recalls a
 * note only platform rehydration could supply, then the stayer answers a liveness probe.
 */
import { describe, it } from "vitest";

import { specs } from "../../toolkit/adapters";
import { Agents } from "../../toolkit/agents";
import { assertDeliveryStatus } from "../../toolkit/assertDelivery";
import { assertReplied, assertReplyContains } from "../../toolkit/assertMessages";
import { DELIVERY_STATUS, observeAgent } from "../../toolkit/observeDelivery";
import { observeRoom } from "../../toolkit/observeMessages";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";
import { uniqueMarker } from "../samples/markers";
import {
  assertRunnable,
  OWN_SESSION_RESUME_ADAPTERS,
  RECALL,
  REHYDRATE_PROMPT,
  REHYDRATION_EXTENDED_WAIT_MS,
  REHYDRATION_SCENARIO_TIMEOUT_MS,
  remember,
} from "../samples/rehydration";

const SCENARIO = scenarioId(CATEGORY.platform, "rehydrationPartial");

describe(SCENARIO, () => {
  for (const spec of specs({ exclude: OWN_SESSION_RESUME_ADAPTERS })) {
    it(spec.id, async () => {
      assertRunnable(spec);
      await using cell = await Agents.cell(spec, REHYDRATE_PROMPT);
      await using stayer = await cell.provision("stayer");
      await using rebooter = await cell.provision("rebooter");
      await using room = await Rooms.create();
      await Rooms.addParticipant(room, stayer);
      await Rooms.addParticipant(room, rebooter);

      const note = uniqueMarker("note");
      await using _stayer = await cell.runAs(stayer);

      {
        await using _rebooter1 = await cell.runAs(rebooter);
        const sent = await Rooms.sendMention(room, rebooter, remember(note));
        assertDeliveryStatus(await observeAgent(rebooter, room).untilProcessed(sent), DELIVERY_STATUS.processed);
      }

      await using _rebooter2 = await cell.runAs(rebooter);
      const recall = await Rooms.sendMention(room, rebooter, RECALL);
      const reply = await observeRoom(room).untilReply(rebooter, { after: recall, timeoutMs: REHYDRATION_EXTENDED_WAIT_MS });
      assertReplyContains(reply, note);

      const probe = await Rooms.sendMention(room, stayer, "Quick check-in — are you still there? A one-line reply is fine.");
      assertReplied(await observeRoom(room).untilReply(stayer, { after: probe }));
    }, REHYDRATION_SCENARIO_TIMEOUT_MS);
  }
});
