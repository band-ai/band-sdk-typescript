/**
 * Cold-boot recall of a note posted while no adapter is running: the note is
 * only visible via platform `/context` rehydration on first boot.
 */
import { describe, it } from "vitest";

import { specs } from "../../toolkit/adapters";
import { Agents } from "../../toolkit/agents";
import { assertReplyContains } from "../../toolkit/assertMessages";
import { observeRoom } from "../../toolkit/observeMessages";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";
import { uniqueMarker } from "../samples/markers";
import {
  assertRunnable,
  OWN_SESSION_RESUME_ADAPTERS,
  RECALL,
  REHYDRATE_PROMPT,
  REHYDRATION_COLD_BOOT_WAIT_MS,
  REHYDRATION_SCENARIO_TIMEOUT_MS,
  remember,
} from "../samples/rehydration";

const SCENARIO = scenarioId(CATEGORY.platform, "rehydrationOffline");

describe(SCENARIO, () => {
  for (const spec of specs({ exclude: OWN_SESSION_RESUME_ADAPTERS })) {
    it(spec.id, async () => {
      assertRunnable(spec);
      await using cell = await Agents.cell(spec, REHYDRATE_PROMPT);
      await using identity = await cell.provision();
      await using room = await Rooms.create();
      await Rooms.addParticipant(room, identity);

      const note = uniqueMarker("note");
      await Rooms.sendMention(room, identity, remember(note));

      await using _running = await cell.runAs(identity);
      const recall = await Rooms.sendMention(room, identity, RECALL);
      const reply = await observeRoom(room).untilReply(identity, { after: recall, timeoutMs: REHYDRATION_COLD_BOOT_WAIT_MS });
      assertReplyContains(reply, note);
    }, REHYDRATION_SCENARIO_TIMEOUT_MS);
  }
});
