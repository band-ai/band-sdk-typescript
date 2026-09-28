/**
 * Cold-boot recall of a note posted while the identity has no running adapter
 * at all: the note is never seen live, so on the identity's one and only
 * boot, a correct recall can only come from the platform rehydrating the
 * room's history via `/context`. Builds its own cell instead of going through
 * `perAdapter`, whose cast-opening runs the agent before a scenario body
 * starts — incompatible with "no adapter running yet" here.
 *
 * Narrower than SESSION_BACKED_ADAPTERS: only codex and opencode resume their
 * own backend session on restart instead of reading platform `/context`, so
 * only those two would pass here without validating this rehydration.
 */
import { describe, it } from "vitest";

import { LIVE_EVENT_TIMEOUT_MS } from "../../../integration/support/liveHarness";
import { ADAPTER, specs, type AdapterId } from "../../toolkit/adapters";
import { Agents } from "../../toolkit/agents";
import { assertReplyContains } from "../../toolkit/assertMessages";
import { observeRoom } from "../../toolkit/observeMessages";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";
import { uniqueMarker } from "../samples/markers";
import { assertRunnable, RECALL, REHYDRATE_PROMPT, remember } from "../samples/rehydration";

const SCENARIO = scenarioId(CATEGORY.platform, "rehydrationOffline");

/** Both resume their own backend session on restart, not platform `/context`. */
const EXCLUDED_ADAPTERS: readonly AdapterId[] = [ADAPTER.codex, ADAPTER.opencode];

// Cold boot, the backlog drain, and the recall turn itself.
const COLD_BOOT_WAIT_MS = LIVE_EVENT_TIMEOUT_MS + 180_000;

describe(SCENARIO, () => {
  for (const spec of specs({ exclude: EXCLUDED_ADAPTERS })) {
    it(spec.id, async () => {
      assertRunnable(spec);
      await using cell = await Agents.cell(spec, REHYDRATE_PROMPT);
      await using identity = await cell.provision();
      await using room = await Rooms.create();
      await Rooms.addParticipant(room, identity);

      const note = uniqueMarker("note");
      // No adapter running yet: never barriered, never seen live. The REST
      // call returning means it is persisted and will surface in /context on boot.
      await Rooms.sendMention(room, identity, remember(note));

      // First and only boot: a correct recall can only come from platform rehydration.
      await using _running = await cell.runAs(identity);
      const recall = await Rooms.sendMention(room, identity, RECALL);
      const reply = await observeRoom(room).untilReply(identity, { after: recall, timeoutMs: COLD_BOOT_WAIT_MS });
      assertReplyContains(reply, note);
    });
  }
});
