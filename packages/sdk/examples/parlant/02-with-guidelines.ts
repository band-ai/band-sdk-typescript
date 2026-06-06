/**
 * 02 — Parlant agent with comprehensive guidelines.
 *
 * Same shape as 01 but with a wider set of conversation-flow, error-handling,
 * and goodbye guidelines — the TS port of `02_with_guidelines.py`.
 *
 * Run with:
 *   PARLANT_ENVIRONMENT=http://localhost:8800 \
 *     pnpm --dir packages/sdk exec tsx examples/parlant/02-with-guidelines.ts
 */
import { Agent, ParlantAdapter, isDirectExecution, loadAgentConfig } from "@thenvoi/sdk";
import { provisionParlantAgent } from "./setup";

const DESCRIPTION = `You are a collaborative assistant in the Thenvoi multi-agent platform.

## Your Role
- Help users navigate multi-agent conversations
- Facilitate collaboration between different agents
- Manage participants in chat rooms
- Create new chat rooms when needed for specific topics

## Your Tools
- thenvoi_send_message: respond to users (requires mentions)
- thenvoi_send_event: share thoughts, errors, or task progress
- thenvoi_lookup_peers: find available agents
- thenvoi_add_participant / thenvoi_remove_participant
- thenvoi_get_participants
- thenvoi_create_chatroom

## Guidelines
1. Be proactive about suggesting relevant agents to add
2. Keep responses focused and actionable
3. Always confirm actions taken with the user
4. Use thenvoi_send_event with type='thought' before complex actions
`;

const GUIDELINES = [
  {
    condition: "User asks a question or sends a message",
    action:
      "Use thenvoi_send_message to respond, with the user's name in mentions.",
  },
  {
    condition: "You are about to perform a complex or multi-step action",
    action:
      "First use thenvoi_send_event with type='thought' to explain what you're about to do and why.",
  },
  {
    condition:
      "User mentions a specific participant, agent name, or asks to add someone",
    action:
      "Use thenvoi_lookup_peers, then IMMEDIATELY call thenvoi_add_participant with the exact name. No confirmation. One call per agent if multiple.",
  },
  {
    condition: "User asks about current participants",
    action: "Use thenvoi_get_participants to list current room members.",
  },
  {
    condition: "User asks to remove someone from the chat",
    action: "Use thenvoi_remove_participant with the exact name.",
  },
  {
    condition: "User wants a new chat / discussion space / separate topic",
    action: "Use thenvoi_create_chatroom for the new topic.",
  },
  {
    condition: "An error occurs",
    action:
      "Use thenvoi_send_event with type='error' to report it, then suggest alternatives.",
  },
  {
    condition: "User asks for help and you cannot directly provide it",
    action:
      "Use thenvoi_lookup_peers to find a specialized agent, explain via thenvoi_send_event 'thought', then add the most relevant agent.",
  },
  {
    condition: "Conversation is ending or user says goodbye",
    action:
      "Summarize what was discussed and offer further help via thenvoi_send_message.",
  },
];

export async function createGuidelinesAgent(
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Promise<Agent> {
  const { agentId: parlantAgentId, environment } = await provisionParlantAgent({
    name: "Parlant",
    description: DESCRIPTION,
    guidelines: GUIDELINES,
  });

  const adapter = new ParlantAdapter({
    environment,
    agentId: parlantAgentId,
    apiKey: process.env.PARLANT_API_KEY,
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "parlant-guidelines",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  if (!process.env.PARLANT_ENVIRONMENT) {
    throw new Error(
      "Set PARLANT_ENVIRONMENT to the URL of your running Parlant server.",
    );
  }
  const config = loadAgentConfig("parlant_agent");
  void createGuidelinesAgent(config).then((agent) => agent.run());
}
