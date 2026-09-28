/**
 * Peer B (google-adk) mentions A with a marker, then stops; A cold-boots and must
 * recall the marker from agent-scoped `/context`. Excludes session-backed adapters
 * and google-adk so A is always a different framework than B.
 */
import { describe, expect, it } from "vitest";

import { ADAPTER, registry, specs } from "../../toolkit/adapters";
import { Agents, type AgentIdentity } from "../../toolkit/agents";
import { assertReplied, assertReplyContains } from "../../toolkit/assertMessages";
import { observeRoom } from "../../toolkit/observeMessages";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";
import { uniqueMarker } from "../samples/markers";
import {
  assertRunnable,
  REHYDRATE_PROMPT,
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

      const marker = uniqueMarker("note");
      {
        await using _speaking = await peerCell.runAs(speaker, relayPrompt(recaller, marker));
        const sent = await Rooms.sendMention(room, speaker, `Please pass a note to ${recaller.name}.`);
        const reply = await observeRoom(room).untilReply(speaker, { after: sent });
        assertReplied(reply);
        expect(reply.message.mentionIds, "B's message must mention A").toContain(recaller.id);
        expect(reply.message.content, "B's message must carry the marker").toContain(marker);
      }

      await using _recalling = await cell.runAs(recaller);
      const recall = await Rooms.sendMention(
        room,
        recaller,
        "Earlier the other participant sent you a short note with a token. Reply with just that token.",
      );
      const reply = await observeRoom(room).untilReply(recaller, { after: recall, timeoutMs: REHYDRATION_EXTENDED_WAIT_MS });
      assertReplyContains(reply, marker);
    }, REHYDRATION_SCENARIO_TIMEOUT_MS);
  }
});
