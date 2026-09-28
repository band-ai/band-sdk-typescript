/**
 * A cold restart is idempotent: run 1 hands the identity three completed
 * turns then stops cleanly; between runs an offline recall queues while the
 * agent is down; run 2 boots cold, answers the offline recall from the
 * platform's boot-drain, and none of run 1's already-handled messages shows a
 * fresh `processing` transition — the model-independent signal that a
 * completed turn isn't redrained from the server's unprocessed queue on boot.
 * Builds its own cell instead of going through `perAdapter`, whose
 * cast-opening runs the agent before a scenario body starts — incompatible
 * with this scenario's controlled stop/cold-restart lifecycle.
 *
 * Rehydration re-sends room history to the model, so a weak model may
 * re-mention or even re-invoke an earlier turn's instructions in its new
 * reply; that isn't redelivery, so dedup is asserted on delivery state, not
 * reply content.
 *
 * Excludes SESSION_BACKED_ADAPTERS: each resumes its own backend session on
 * restart instead of draining the platform's `/next` queue, so none of them
 * would exercise the redrain-avoidance this scenario asserts.
 */
import { describe, expect, it } from "vitest";

import { LIVE_EVENT_TIMEOUT_MS } from "../../../integration/support/liveHarness";
import { specs } from "../../toolkit/adapters";
import { Agents } from "../../toolkit/agents";
import { assertDeliveryStatus } from "../../toolkit/assertDelivery";
import { assertReplyContains } from "../../toolkit/assertMessages";
import { DELIVERY_STATUS, observeAgent } from "../../toolkit/observeDelivery";
import { observeRoom } from "../../toolkit/observeMessages";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms, type SentMessage } from "../../toolkit/rooms";
import { uniqueMarker } from "../samples/markers";
import { assertRunnable, RECALL, REHYDRATE_PROMPT, remember, SESSION_BACKED_ADAPTERS } from "../samples/rehydration";

const SCENARIO = scenarioId(CATEGORY.platform, "rehydrationIdempotency");

// The offline recall's boot-drain reply, past the cold boot itself.
const EXTENDED_WAIT_MS = LIVE_EVENT_TIMEOUT_MS + 300_000;

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
        // Run 1: state a note, invite echo, answer a marked probe — then stop
        // cleanly, so mark_processed runs for every one of these turns.
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

      // Between runs (agent down): queue an offline recall so the boot-drain
      // has exactly one genuinely unprocessed message to answer.
      const offlineMsg = await Rooms.sendMention(room, identity, RECALL);

      // Run 2 (cold): the boot-drain answers the offline question on startup.
      await using _run2 = await cell.runAs(identity);
      const bootReply = await observeRoom(room).untilReply(identity, { after: offlineMsg, timeoutMs: EXTENDED_WAIT_MS });
      assertReplyContains(bootReply, note);

      // Dedup (model-independent): none of run 1's already-handled messages
      // was re-drained from the server's unprocessed queue on cold boot, so
      // each shows exactly the one [processing, processed] cycle it got in run 1.
      const delivery = observeAgent(identity, room);
      for (const message of [noteMsg, inviteMsg, handledMsg]) {
        expect(delivery.history(message), `message ${message.id} was re-processed on cold boot`).toEqual([
          DELIVERY_STATUS.processing,
          DELIVERY_STATUS.processed,
        ]);
      }
    });
  }
});
