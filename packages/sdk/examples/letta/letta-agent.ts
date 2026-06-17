import { Agent, LettaAdapter, loadAgentConfig, isDirectExecution } from "../../src/index";
import { ConsoleLogger } from "../../src/core/logger";

export function createLettaAgent(
  options: {
    model?: string;
    lettaApiKey?: string;
    lettaBaseUrl?: string;
  },
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = new LettaAdapter({
    model: options.model ?? "openai/gpt-4o",
    lettaApiKey: options.lettaApiKey,
    lettaBaseUrl: options.lettaBaseUrl,
    logger: new ConsoleLogger(),
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "agent-letta",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: {
      autoSubscribeExistingRooms: true,
    },
  });
}

if (isDirectExecution(import.meta.url)) {
  const lettaApiKey = process.env.LETTA_API_KEY;
  const lettaBaseUrl = process.env.LETTA_BASE_URL;

  if (!lettaApiKey && !lettaBaseUrl) {
    throw new Error(
      "Set LETTA_API_KEY (cloud) or LETTA_BASE_URL (self-hosted) to run this example.",
    );
  }

  const config = loadAgentConfig("letta_agent");
  console.log("[letta-agent] Starting with config:", JSON.stringify(config));
  console.log("[letta-agent] Model:", process.env.LETTA_MODEL ?? "openai/gpt-4o");
  console.log("[letta-agent] Base URL:", lettaBaseUrl ?? "cloud");
  void createLettaAgent(
    {
      model: process.env.LETTA_MODEL,
      lettaApiKey,
      lettaBaseUrl,
    },
    config,
  ).run().then(() => console.log("[letta-agent] run() resolved")).catch((e) => console.error("[letta-agent] run() error:", e));
}
