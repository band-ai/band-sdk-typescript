/**
 * Peer B (google-adk) mentions A with a marker while A is down. A cold-boots and
 * answers that note, then stops; the recall is posted while A is down again, so
 * A's second cold boot has only the recall pending and can reach the marker
 * only through agent-scoped `/context`. Excludes session-backed adapters and
 * google-adk so A is always a different framework than B.
 */
import { describe, expect, it } from "vitest";

import { ADAPTER, registry, specs } from "../../toolkit/adapters";
import { Agents, type AgentIdentity } from "../../toolkit/agents";
import { assertDeliveryStatus } from "../../toolkit/assertDelivery";
import { assertReplied } from "../../toolkit/assertMessages";
import { DELIVERY_STATUS, observeAgent } from "../../toolkit/observeDelivery";
import { observeRoom } from "../../toolkit/observeMessages";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";
import { scenarioEvidence } from "../../toolkit/scenarioEvidence";
import { carriesMarkerCode, uniqueMarker } from "../samples/markers";
import {
  assertRunnable,
  REHYDRATE_PROMPT,
  REHYDRATION_COLD_BOOT_WAIT_MS,
  REHYDRATION_EXTENDED_WAIT_MS,
  REHYDRATION_SCENARIO_TIMEOUT_MS,
  SESSION_BACKED_ADAPTERS,
} from "../samples/rehydration";

const SCENARIO = scenarioId(CATEGORY.platform, "rehydrationCrossFramework");

const PEER_ADAPTER = ADAPTER.googleAdk;
const EXCLUDED_ADAPTERS = [...SESSION_BACKED_ADAPTERS, PEER_ADAPTER];

function relayPrompt(target: AgentIdentity, marker: string): string {
  return (
    `${REHYDRATE_PROMPT} When asked, send exactly one message that mentions the participant named ` +
    `"${target.name}" and contains this exact token: ${marker}. Address it to them and include nothing else of substance.`
  );
}

describe(SCENARIO, () => {
  for (const spec of specs({ exclude: EXCLUDED_ADAPTERS })) {
    it(spec.id, async () => {
      assertRunnable(spec);
      const peerSpec = registry.get(PEER_ADAPTER);
      assertRunnable(peerSpec);

      await using cell = await Agents.cell(spec, REHYDRATE_PROMPT);
      await using peerCell = await Agents.cell(peerSpec, REHYDRATE_PROMPT);
      await using recaller = await cell.provision("recaller");
      await using speaker = await peerCell.provision("speaker");
      await using room = await Rooms.create();
      await Rooms.addParticipant(room, recaller);
      await Rooms.addParticipant(room, speaker);
      const evidence = scenarioEvidence(room, recaller);

      await evidence.run(async () => {
        const marker = uniqueMarker("note");
        const delivery = observeAgent(recaller, room);
        let note: { id: string };
        {
          await using _speaking = await peerCell.runAs(speaker, relayPrompt(recaller, marker));
          const sent = await Rooms.sendMention(room, speaker, `Please pass a note to ${recaller.name}.`);
          const reply = await observeRoom(room).untilReply(speaker, { after: sent });
          assertReplied(reply);
          expect(reply.message.mentionIds, "B's message must mention A").toContain(recaller.id);
          expect(reply.message.content, "B's message must carry the marker").toContain(marker);
          note = reply.message;
        }
        {
          await using _answering = await cell.runAs(recaller);
          assertDeliveryStatus(await delivery.untilProcessed(note, REHYDRATION_COLD_BOOT_WAIT_MS), DELIVERY_STATUS.processed, "B's note");
        }

        const recall = await Rooms.sendMention(
          room,
          recaller,
          "Earlier the other participant sent you a short note with a token. Reply with just that token.",
        );
        await using _recalling = await cell.runAs(recaller);
        const [reply, recallDelivery] = await Promise.all([
          observeRoom(room).untilReplyMatching(recaller, (message) => carriesMarkerCode(message.content, marker), {
            after: recall,
            timeoutMs: REHYDRATION_EXTENDED_WAIT_MS,
          }),
          delivery.untilProcessed(recall, REHYDRATION_EXTENDED_WAIT_MS),
        ]);
        const noteStatuses = delivery.history(note);
        evidence.record({ marker, note, recall, reply, recallDelivery, noteStatuses });
        assertDeliveryStatus(recallDelivery, DELIVERY_STATUS.processed, "the recall");
        // The boot drain serves the note before the recall, so a re-run would show by now.
        expect(
          noteStatuses.slice(noteStatuses.indexOf(DELIVERY_STATUS.processed) + 1),
          "B's note ran again on the second boot, so a reply to it could pass for the recall",
        ).toEqual([]);
        assertReplied(reply);
      });
    }, REHYDRATION_SCENARIO_TIMEOUT_MS);
  }
});
