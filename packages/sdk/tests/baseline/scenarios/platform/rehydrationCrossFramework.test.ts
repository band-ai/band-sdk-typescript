/**
 * A different-framework peer's message rehydrates into A's agent-scoped
 * context: peer B (fixed to google-adk) authors one message mentioning A and
 * carrying a marker, then stops; A cold-boots and must recall the marker.
 * Rehydrated `/context` is agent-scoped — only messages A authored or was
 * mentioned in — so B's mention is what lands its message in A's context,
 * not decoration; a setup precondition checks that before trusting recall.
 * Builds its own cells instead of going through `perAdapter`, whose
 * cast-opening runs a single agent before a scenario body starts —
 * incompatible with this scenario's two frameworks and controlled boot order.
 *
 * Excludes SESSION_BACKED_ADAPTERS (they resume their own backend session on
 * restart, not platform `/context`) plus google-adk, so A is always built
 * from a different framework than the fixed peer B.
 */
import { describe, expect, it } from "vitest";

import { LIVE_EVENT_TIMEOUT_MS } from "../../../integration/support/liveHarness";
import { ADAPTER, registry, specs, type AdapterId } from "../../toolkit/adapters";
import { Agents, type AgentIdentity } from "../../toolkit/agents";
import { assertReplied, assertReplyContains } from "../../toolkit/assertMessages";
import { observeRoom } from "../../toolkit/observeMessages";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";
import { uniqueMarker } from "../samples/markers";
import { assertRunnable, REHYDRATE_PROMPT, SESSION_BACKED_ADAPTERS } from "../samples/rehydration";

const SCENARIO = scenarioId(CATEGORY.platform, "rehydrationCrossFramework");

/** The fixed foreign peer; excluded from the fanned cell so it can't also be A. */
const PEER_ADAPTER = ADAPTER.googleAdk;

const EXCLUDED_ADAPTERS: readonly AdapterId[] = [...SESSION_BACKED_ADAPTERS, PEER_ADAPTER];

// Peer boot + relay turn + A's fresh cold boot + the recall turn.
const EXTENDED_WAIT_MS = LIVE_EVENT_TIMEOUT_MS + 300_000;

/** Drives B to send exactly one message mentioning `target` and carrying `marker`. */
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
        // B (a different framework) authors one message mentioning A and
        // carrying the marker, then stops.
        await using _speaking = await peerCell.runAs(speaker, relayPrompt(recaller, marker));
        const sent = await Rooms.sendMention(room, speaker, `Please pass a note to ${recaller.name}.`);
        const reply = await observeRoom(room).untilReply(speaker, { after: sent });
        assertReplied(reply);
        // Setup precondition: the mention is what lands B's message in A's
        // agent-scoped context, so it must actually be there before trusting recall.
        expect(reply.message.mentionIds, "B's message must mention A").toContain(recaller.id);
        expect(reply.message.content, "B's message must carry the marker").toContain(marker);
      }

      // A cold-boots under its own identity — no in-memory history — so a
      // correct recall can only come from rehydrating B's message on bootstrap.
      await using _recalling = await cell.runAs(recaller);
      const recall = await Rooms.sendMention(
        room,
        recaller,
        "Earlier the other participant sent you a short note with a token. Reply with just that token.",
      );
      const reply = await observeRoom(room).untilReply(recaller, { after: recall, timeoutMs: EXTENDED_WAIT_MS });
      assertReplyContains(reply, marker);
    });
  }
});
