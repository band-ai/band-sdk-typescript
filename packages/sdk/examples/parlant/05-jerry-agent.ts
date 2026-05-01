/**
 * 05 — Jerry the mouse (Parlant).
 *
 * Counterpart to 04 — provisions a Parlant agent with Jerry's character
 * description and a single "stay in character" guideline, then connects it
 * to Thenvoi.
 *
 * Run with:
 *   PARLANT_ENVIRONMENT=http://localhost:8800 \
 *     pnpm --dir packages/sdk exec tsx examples/parlant/05-jerry-agent.ts
 */
import { Agent, ParlantAdapter, isDirectExecution, loadAgentConfig } from "@thenvoi/sdk";
import {
  generateJerryPrompt,
  provisionParlantAgent,
} from "./setup";

export async function createJerryAgent(
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Promise<Agent> {
  const { agentId: parlantAgentId, environment } = await provisionParlantAgent({
    name: "Jerry",
    description: generateJerryPrompt("Jerry"),
    guidelines: [
      {
        condition: "User sends a message or asks something",
        action:
          "Respond using thenvoi_send_message with the user's name in mentions. Stay in character as Jerry the mouse.",
      },
    ],
  });

  const adapter = new ParlantAdapter({
    environment,
    agentId: parlantAgentId,
    apiKey: process.env.PARLANT_API_KEY,
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "parlant-jerry",
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
  const config = loadAgentConfig("jerry_agent");
  console.log("Jerry is cozy in his hole, watching for Tom...");
  void createJerryAgent(config).then((agent) => agent.run());
}
