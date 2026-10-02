/**
 * An agent changes the room roster through its Band tools, and remembers its
 * previous turn while doing it: the flow shared by agents that hold the Band
 * tools themselves (over MCP for the ACP coding agents, as client tools for
 * Letta).
 */
import { expect } from "vitest";

import type { AgentIdentity } from "../../toolkit/agents";
import { assertReplied } from "../../toolkit/assertMessages";
import { history, MESSAGE_TYPE, observeRoom } from "../../toolkit/observeMessages";
import type { Cast } from "../../toolkit/perAdapter";
import { type Room, Rooms } from "../../toolkit/rooms";
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
  const participants = await Rooms.participantIds(room);
  // The reply alone can't tell a failed add from a skipped one; the agent's tool events can.
  const toolEvents = participants.includes(helper.id) ? [] : await agentToolEvents(room, agent!);
  expect(participants, `the helper joined through band_add_participant; the agent's tool events: ${toolEvents.join(" | ")}`).toContain(
    helper.id,
  );
  return { helperName: helper.name };
}

const TOOL_EVENT_TYPES: ReadonlySet<string> = new Set([MESSAGE_TYPE.ToolCall, MESSAGE_TYPE.ToolResult]);

/** The agent's calls and results in order, raw: ACP tool events don't parse as `toolCalls` does. */
async function agentToolEvents(room: Room, agent: AgentIdentity): Promise<string[]> {
  return (await history(room))
    .filter((event) => event.senderId === agent.id && TOOL_EVENT_TYPES.has(event.messageType))
    .map((event) => `${event.messageType}: ${event.content} ${JSON.stringify(event.metadata)}`);
}
