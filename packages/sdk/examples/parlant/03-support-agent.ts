/**
 * 03 — Customer support agent (Parlant).
 *
 * Realistic customer support persona with empathy / urgency / escalation
 * guidelines. TS port of `03_support_agent.py`.
 *
 * Run with:
 *   PARLANT_ENVIRONMENT=http://localhost:8800 \
 *     pnpm --dir packages/sdk exec tsx examples/parlant/03-support-agent.ts
 */
import { Agent, ParlantAdapter, isDirectExecution, loadAgentConfig } from "@thenvoi/sdk";
import { provisionParlantAgent } from "./setup";

const SUPPORT_DESCRIPTION = `You are a customer support agent for TechCo Solutions.

Your responsibilities:
- Handle customer inquiries with professionalism and empathy
- Resolve issues efficiently while maintaining quality
- Escalate complex issues to specialists when needed
- Document interactions for follow-up

Communication style:
- Friendly but professional
- Clear and concise
- Solution-focused
- Proactive about next steps

Remember:
- Customer satisfaction is the top priority
- Never make promises you can't keep
- Always follow up on commitments
`;

const SUPPORT_GUIDELINES = [
  {
    condition: "Customer asks about refunds or returns",
    action:
      "Express empathy first, then ask for order details (order number, item) before providing refund information.",
  },
  {
    condition: "Customer is frustrated or upset",
    action:
      "Acknowledge their frustration, apologize for any inconvenience, and focus on finding a solution.",
  },
  {
    condition: "Customer asks a technical question",
    action: "Ask about their setup (device, OS, version) before troubleshooting.",
  },
  {
    condition: "Issue cannot be resolved by this agent",
    action:
      "Explain the limitation clearly and offer to escalate to a specialist by adding them to the conversation.",
  },
  {
    condition: "Customer provides positive feedback",
    action: "Thank them warmly and ask if there's anything else you can help with.",
  },
  {
    condition: "Customer mentions urgency or a deadline",
    action: "Prioritize their request and provide the fastest path to resolution.",
  },
];

export async function createSupportAgent(
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Promise<Agent> {
  const { agentId: parlantAgentId, environment } = await provisionParlantAgent({
    name: "Support",
    description: SUPPORT_DESCRIPTION,
    guidelines: SUPPORT_GUIDELINES,
  });

  const adapter = new ParlantAdapter({
    environment,
    agentId: parlantAgentId,
    apiKey: process.env.PARLANT_API_KEY,
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "parlant-support",
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
  const config = loadAgentConfig("support_agent");
  void createSupportAgent(config).then((agent) => agent.run());
}
