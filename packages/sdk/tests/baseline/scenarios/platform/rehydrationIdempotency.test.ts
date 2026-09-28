/**
 * Cold restart must not redrain completed work: run 1 finishes three turns, an
 * offline recall queues while down, run 2 answers it from boot-drain, and run 1
 * messages keep a single [processing, processed] cycle. Dedup is on delivery state,
 * not reply content. Excludes session-backed adapters (they do not drain `/next`).
 */
import { describe, expect, it } from "vitest";

import { specs } from "../../toolkit/adapters";
import { Agents } from "../../toolkit/agents";
import { assertDeliveryStatus } from "../../toolkit/assertDelivery";
import { assertReplyContains } from "../../toolkit/assertMessages";
import { DELIVERY_STATUS, observeAgent } from "../../toolkit/observeDelivery";
import { observeRoom } from "../../toolkit/observeMessages";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms, type SentMessage } from "../../toolkit/rooms";
import { uniqueMarker } from "../samples/markers";
import {
  assertRunnable,
  RECALL,
  REHYDRATE_PROMPT,
  REHYDRATION_EXTENDED_WAIT_MS,
  REHYDRATION_SCENARIO_TIMEOUT_MS,
  remember,
  SESSION_BACKED_ADAPTERS,
} from "../samples/rehydration";


const SCENARIO = scenarioId(CATEGORY.platform, "rehydrationIdempotency");

describe(SCENARIO, () => {
  for (const spec of specs({ exclude: SESSION_BACKED_ADAPTERS })) {
    it(spec.id, async () => {
      assertRunnable(spec);
      await using cell = await Agents.cell(spec, REHYDRATE_PROMPT);
      await using identity = await cell.provision();
      await using echo = await cell.provision("echo");
      await using room = await Rooms.create();
      await Rooms.addParticipant(room, identity);

      const note = uniqueMarker("note");
      const handled = uniqueMarker("handled");
      let noteMsg: SentMessage;
      let inviteMsg: SentMessage;
      let handledMsg: SentMessage;

      {
        await using _run1 = await cell.runAs(identity);
        const delivery = observeAgent(identity, room);

        noteMsg = await Rooms.sendMention(room, identity, remember(note));
        assertDeliveryStatus(await delivery.untilProcessed(noteMsg), DELIVERY_STATUS.processed);

        inviteMsg = await Rooms.sendMention(
          room,
          identity,
          `Use the band_add_participant MCP tool to add the available agent named ${echo.name} to this room as a member. ` +
            "This changes the room roster and cannot be done by replying with text.",
        );
        assertDeliveryStatus(await delivery.untilProcessed(inviteMsg), DELIVERY_STATUS.processed);

        handledMsg = await Rooms.sendMention(room, identity, `To confirm you're still active, please reply with the word ${handled}.`);
        assertReplyContains(await observeRoom(room).untilReply(identity, { after: handledMsg }), handled);
      }
      expect(await Rooms.participantIds(room), `${echo.name} invited into the room through band_add_participant`).toContain(echo.id);

      const offlineMsg = await Rooms.sendMention(room, identity, RECALL);

      await using _run2 = await cell.runAs(identity);
      const bootReply = await observeRoom(room).untilReply(identity, { after: offlineMsg, timeoutMs: REHYDRATION_EXTENDED_WAIT_MS });
      assertReplyContains(bootReply, note);

      const delivery = observeAgent(identity, room);
      for (const message of [noteMsg, inviteMsg, handledMsg]) {
        expect(delivery.history(message), `message ${message.id} was re-processed on cold boot`).toEqual([
          DELIVERY_STATUS.processing,
          DELIVERY_STATUS.processed,
        ]);
      }
    }, REHYDRATION_SCENARIO_TIMEOUT_MS);
  }
});
