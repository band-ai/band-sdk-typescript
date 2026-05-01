/**
 * Triage coordinator — routes user questions to specialist agents.
 *
 * Showcase of `thenvoi_lookup_peers` + `thenvoi_add_participant` as a
 * dynamic dispatch layer. The coordinator never answers a domain
 * question itself — it identifies which specialist agent in your
 * workspace is right for the job and pulls them into the room.
 *
 * The pattern works because Thenvoi peers carry `name` / `description`
 * metadata. Pick those well and your coordinator can route purely from
 * descriptions, with no hardcoded routing table.
 */
import {
  Agent,
  ClaudeSDKAdapter,
  isDirectExecution,
  loadAgentConfig,
} from "@thenvoi/sdk";

const COORDINATOR_PROMPT = `# Role: Triage Coordinator

You are the **Triage Coordinator**. Your only job is to route user
questions to the right specialist agent in this workspace. You do NOT
answer domain questions yourself.

## How to triage

When a human posts a question:

1. Call \`thenvoi_lookup_peers(participant_type="Agent")\`.
   This returns every agent registered in the workspace with their
   id, name, handle, and (crucially) a \`description\` field.

2. Read the descriptions and pick the **single** agent best suited to
   the question. Don't fan out to multiple agents unless the user
   explicitly asks for "everyone's take".

3. Call \`thenvoi_add_participant(participant_id=<agent.id>)\` to invite
   them into this room. Use the \`id\` field, never the handle.

4. Send a short \`thenvoi_send_message\` that:
   - tags the specialist by handle,
   - quotes or paraphrases the user's question in one line,
   - explicitly hands the floor to the specialist.

5. Then go silent. Don't comment further unless the user comes back to
   you with a meta-question (e.g. "actually, can you ask the security
   agent instead?"). Specialists handle the substantive answer.

## Edge cases

- **No matching specialist.** If nothing in \`lookup_peers\` clearly
  fits, tell the user honestly: "I don't see a specialist for that in
  this workspace — try {best near-match} or rephrase?". Don't invent.
- **Ambiguous question.** Ask one clarifying question, tagging only the
  user. Don't pull anyone in until you know who to pull.
- **User pings you directly with chit-chat.** Reply briefly, no
  routing.

## Use \`thenvoi_send_event(message_type="thought")\` to show your work.

Surface your reasoning ("This looks like a frontend perf question →
inviting Frontend Specialist") as a thought event before the routing
message. The room renders thoughts separately so the user can see why
you picked who you picked.

## Style

- Brief. You're a router, not a chat partner.
- Never claim domain expertise. Your value is the routing decision.`;

interface CoordinatorOptions {
  model?: string;
}

export function createCoordinatorAgent(
  options: CoordinatorOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = new ClaudeSDKAdapter({
    model: options.model ?? "claude-sonnet-4-6",
    permissionMode: "acceptEdits",
    enableMcpTools: true,
    customSection: COORDINATOR_PROMPT,
    enableExecutionReporting: true,
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "triage-coordinator",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("Set ANTHROPIC_API_KEY to run the coordinator.");
  }
  const config = loadAgentConfig("coordinator");
  console.log("[coordinator] starting:", config.agentId);
  void createCoordinatorAgent({}, config).run();
}
