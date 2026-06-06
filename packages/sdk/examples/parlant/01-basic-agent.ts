/**
 * 01 — Basic Parlant agent.
 *
 * Provisions a Parlant agent with the full set of Thenvoi-aware guidelines
 * (send messages, lookup peers, add/remove participants, get participants,
 * create rooms), then plugs that agent into the Thenvoi platform via
 * `ParlantAdapter`.
 *
 * Run with:
 *   PARLANT_ENVIRONMENT=http://localhost:8800 \
 *     pnpm --dir packages/sdk exec tsx examples/parlant/01-basic-agent.ts
 */
import { Agent, ParlantAdapter, isDirectExecution, loadAgentConfig } from "@thenvoi/sdk";
import { provisionParlantAgent } from "./setup";

const AGENT_DESCRIPTION = `You are a helpful, knowledgeable assistant in the Thenvoi multi-agent platform.

## Your Tools
1. thenvoi_send_message — send messages to users/agents (requires @mentions)
2. thenvoi_send_event — share reasoning ('thought'), errors, or progress ('task')
3. thenvoi_lookup_peers — find agents that can help with specific topics
4. thenvoi_add_participant — invite agents/users to the current room
5. thenvoi_remove_participant — remove participants
6. thenvoi_get_participants — see who's in the room
7. thenvoi_create_chatroom — create new rooms for specific discussions

## How to Respond
- Give detailed, specific answers
- Remember information the user shares
- Reference earlier parts of the conversation
- Ask follow-ups when needed
- Friendly but substantive — avoid generic responses
`;

const GUIDELINES = [
  {
    condition: "User asks a question or needs help with something",
    action:
      "Analyze the request. If you can answer directly, use thenvoi_send_message with the user's name in mentions. If complex, first use thenvoi_send_event with type='thought' to share your reasoning.",
  },
  {
    condition:
      "User asks to add someone, mentions a specific agent name, or asks for specialized help you can't provide",
    action:
      "First use thenvoi_lookup_peers to find available agents. Then IMMEDIATELY call thenvoi_add_participant with the exact name from the lookup result. Do NOT ask for confirmation. If the user wants multiple agents, call once for each.",
  },
  {
    condition: "User asks who is in the room",
    action: "Use thenvoi_get_participants to list all current room members.",
  },
  {
    condition: "User wants to create a new chat room or discussion space",
    action: "Use thenvoi_create_chatroom to create a dedicated space for the new topic.",
  },
  {
    condition: "User asks to remove someone from the chat",
    action:
      "Use thenvoi_remove_participant with the name parameter set to the exact name to remove.",
  },
];

export async function createBasicParlantAgent(
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Promise<Agent> {
  const { agentId: parlantAgentId, environment } = await provisionParlantAgent({
    name: "Parlant",
    description: AGENT_DESCRIPTION,
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
      agentId: overrides?.agentId ?? "parlant-basic",
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
  void createBasicParlantAgent(config).then((agent) => agent.run());
}
