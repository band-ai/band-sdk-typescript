/**
 * A coding agent changes the room roster through its Band MCP tools, and
 * remembers its previous turn while doing it: the flow the ACP coding agents
 * share.
 */
import { expect } from "vitest";

import { assertReplied } from "../../toolkit/assertMessages";
import { observeRoom } from "../../toolkit/observeMessages";
import type { Cast } from "../../toolkit/perAdapter";
import { Rooms } from "../../toolkit/rooms";
import { uniqueMarker } from "./markers";

export interface RosterChange {
  /** The helper the agent added, by name — what its tool call names. */
  helperName: string;
}

export async function addsHelperThroughMcp({ agents: [agent], room, cells: [cell] }: Cast): Promise<RosterChange> {
  await using helper = await cell!.provision("helper");
  const first = uniqueMarker("FIRST");
  const mcp = uniqueMarker("MCP");
  const second = uniqueMarker("SECOND");

  await Rooms.sendMention(room, agent!, `Reply with exactly ${first}.`);
  assertReplied(await observeRoom(room).untilReplyMatching(agent!, (message) => message.content.includes(first)));

  await Rooms.sendMention(
    room,
    agent!,
    `Use the band_add_participant MCP tool to add the available agent named ${helper.name} to this room as a member. ` +
      "This changes the room roster and cannot be done by replying with text. " +
      `After it succeeds, reply in one message with the exact secret word from your previous turn, then ${mcp}, then ${second}.`,
  );
  const reply = await observeRoom(room).untilReplyMatching(agent!, (message) =>
    [first, mcp, second].every((marker) => message.content.includes(marker)),
  );
  assertReplied(reply);
  expect(await Rooms.participantIds(room), "the helper joined through band_add_participant").toContain(helper.id);
  return { helperName: helper.name };
}
