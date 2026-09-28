/**
 * Two agents on different frameworks, asked in turn to greet each other,
 * each address the other: the greeting mentions the other agent or names it.
 * Structural, so no judge decides whether it was warm enough.
 */
import { ADAPTER } from "../../toolkit/adapters";
import type { AgentIdentity } from "../../toolkit/agents";
import { assertReplied } from "../../toolkit/assertMessages";
import { observeRoom, type CapturedMessage } from "../../toolkit/observeMessages";
import { withAdapters } from "../../toolkit/perAdapter";
import { CATEGORY, scenarioId } from "../../toolkit/registry";
import { Rooms, type Room } from "../../toolkit/rooms";

/** Whether `message` is addressed to `other`: a mention of it, or its name. */
const addresses = (message: CapturedMessage, other: AgentIdentity) =>
  message.mentionIds.includes(other.id) || message.content.includes(other.name);

async function greets(room: Room, greeter: AgentIdentity, other: AgentIdentity): Promise<void> {
  await Rooms.sendMention(room, greeter, `please say hello to @${other.name}`);
  const greeting = await observeRoom(room).untilReplyMatching(greeter, (message) => addresses(message, other));
  assertReplied(greeting);
}

withAdapters(
  [ADAPTER.anthropic, ADAPTER.gemini],
  scenarioId(CATEGORY.behavior, "agentScenarios.greetEachOther"),
  async ({ agents: [first, second], room }) => {
    await greets(room, first!, second!);
    await greets(room, second!, first!);
  },
);
