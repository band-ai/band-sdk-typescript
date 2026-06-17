import { Agent, OpenAIAdapter, loadAgentConfig, isDirectExecution } from "../../src/index";

interface OpenAIExampleOptions {
  model?: string;
  apiKey?: string;
}

export function createOpenAIAgent(
  options: OpenAIExampleOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = new OpenAIAdapter({
    openAIModel: options.model ?? "gpt-5.2",
    apiKey: options.apiKey,
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "openai-agent",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("openai_agent");
  void createOpenAIAgent({}, config).run();
}
