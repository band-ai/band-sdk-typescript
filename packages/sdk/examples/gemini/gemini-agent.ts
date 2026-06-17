import { Agent, GeminiAdapter, loadAgentConfig, isDirectExecution } from "../../src/index";

interface GeminiExampleOptions {
  model?: string;
  apiKey?: string;
}

export function createGeminiAgent(
  options: GeminiExampleOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = new GeminiAdapter({
    geminiModel: options.model ?? "gemini-3-flash-preview",
    apiKey: options.apiKey,
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "gemini-agent",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("gemini_agent");
  void createGeminiAgent({}, config).run();
}
