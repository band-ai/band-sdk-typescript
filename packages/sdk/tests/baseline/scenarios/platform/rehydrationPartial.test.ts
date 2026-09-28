/**
 * A partial reboot in a live two-agent room: one identity (the rebooter)
 * cycles through two runs while a second (the stayer) stays up the whole
 * test. The rebooter's cold second run recalls a note that only the
 * platform's /context rehydration could supply; the stayer answers a
 * liveness probe throughout, proving its neighbour's reboot never disturbed
 * it. Builds its own cell instead of going through `perAdapter`, whose
 * cast-opening runs a single agent before a scenario body starts —
 * incompatible with this scenario's two identities and controlled reboot.
 *
 * Narrower than SESSION_BACKED_ADAPTERS: only codex and opencode resume their
 * own backend session on restart instead of reading platform `/context`, so
 * only those two would pass here without validating this rehydration.
 */
import { describe, it } from "vitest";

import { LIVE_EVENT_TIMEOUT_MS } from "../../../integration/support/liveHarness";
import { ADAPTER, specs, type AdapterId } from "../../toolkit/adapters";
import { Agents } from "../../toolkit/agents";
import { assertDeliveryStatus } from "../../toolkit/assertDelivery";
import { assertReplied, assertReplyContains } from "../../toolkit/assertMessages";
import { DELIVERY_STATUS, observeAgent } from "../../toolkit/observeDelivery";
import { observeRoom } from "../../toolkit/observeMessages";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";
import { uniqueMarker } from "../samples/markers";
import { assertRunnable, RECALL, REHYDRATE_PROMPT, remember } from "../samples/rehydration";

const SCENARIO = scenarioId(CATEGORY.platform, "rehydrationPartial");

/** Both resume their own backend session on restart, not platform `/context`. */
const EXCLUDED_ADAPTERS: readonly AdapterId[] = [ADAPTER.codex, ADAPTER.opencode];

// Two boots for the rebooter, the stayer's own boot, and three turns between them.
const EXTENDED_WAIT_MS = LIVE_EVENT_TIMEOUT_MS + 300_000;

describe(SCENARIO, () => {
  for (const spec of specs({ exclude: EXCLUDED_ADAPTERS })) {
    it(spec.id, async () => {
      assertRunnable(spec);
      await using cell = await Agents.cell(spec, REHYDRATE_PROMPT);
      await using stayer = await cell.provision("stayer");
      await using rebooter = await cell.provision("rebooter");
      await using room = await Rooms.create();
      await Rooms.addParticipant(room, stayer);
      await Rooms.addParticipant(room, rebooter);

      const note = uniqueMarker("note");
      // Up for the whole test: it can only answer the liveness probe later if
      // its neighbour's reboot left it undisturbed.
      await using _stayer = await cell.runAs(stayer);

      {
        // Run 1: state the note, then stop cleanly (exit this block).
        await using _rebooter1 = await cell.runAs(rebooter);
        const sent = await Rooms.sendMention(room, rebooter, remember(note));
        assertDeliveryStatus(await observeAgent(rebooter, room).untilProcessed(sent), DELIVERY_STATUS.processed);
      }

      // Run 2: a brand-new adapter under the SAME identity — no in-memory
      // history, so a correct recall proves the platform rehydrated the room.
      await using _rebooter2 = await cell.runAs(rebooter);
      const recall = await Rooms.sendMention(room, rebooter, RECALL);
      const reply = await observeRoom(room).untilReply(rebooter, { after: recall, timeoutMs: EXTENDED_WAIT_MS });
      assertReplyContains(reply, note);

      // Peer continuity: any reply proves the stayer stayed alive through the
      // rebooter's churn — its content isn't the point, its presence is.
      const probe = await Rooms.sendMention(room, stayer, "Quick check-in — are you still there? A one-line reply is fine.");
      assertReplied(await observeRoom(room).untilReply(stayer, { after: probe }));
    });
  }
});
