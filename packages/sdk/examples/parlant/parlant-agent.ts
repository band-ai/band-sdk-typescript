import { Agent, ParlantAdapter, loadAgentConfig, isDirectExecution } from "../../src/index";

export function createParlantAgent(
  options: {
    environment: string;
    agentId: string;
    apiKey?: string;
  },
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = new ParlantAdapter({
    environment: options.environment,
    agentId: options.agentId,
    apiKey: options.apiKey,
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "agent-parlant",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  const environment = process.env.PARLANT_ENVIRONMENT;
  const parlantAgentId = process.env.PARLANT_AGENT_ID;

  if (!environment || !parlantAgentId) {
    throw new Error(
      "Set PARLANT_ENVIRONMENT and PARLANT_AGENT_ID to run this example.",
    );
  }

  const config = loadAgentConfig("parlant_agent");
  void createParlantAgent(
    {
      environment,
      agentId: parlantAgentId,
      apiKey: process.env.PARLANT_API_KEY,
    },
    config,
  ).run();
}
