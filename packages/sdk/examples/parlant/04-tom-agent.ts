/**
 * 04 — Tom the cat (Parlant).
 *
 * Provisions a Parlant agent with Tom's character description and a single
 * "stay in character" guideline, then connects it to Thenvoi.
 *
 * Run with:
 *   PARLANT_ENVIRONMENT=http://localhost:8800 \
 *     pnpm --dir packages/sdk exec tsx examples/parlant/04-tom-agent.ts
 */
import { Agent, ParlantAdapter, isDirectExecution, loadAgentConfig } from "@thenvoi/sdk";
import {
  generateTomPrompt,
  provisionParlantAgent,
} from "./setup";

export async function createTomAgent(
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Promise<Agent> {
  const { agentId: parlantAgentId, environment } = await provisionParlantAgent({
    name: "Tom",
    description: generateTomPrompt("Tom"),
    guidelines: [
      {
        condition: "User sends a message or asks something",
        action:
          "Respond using thenvoi_send_message with the user's name in mentions. Stay in character as Tom the cat.",
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
      agentId: overrides?.agentId ?? "parlant-tom",
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
  const config = loadAgentConfig("tom_agent");
  console.log("Tom is on the prowl, looking for Jerry...");
  void createTomAgent(config).then((agent) => agent.run());
}
