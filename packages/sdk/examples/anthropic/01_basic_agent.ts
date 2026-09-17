import { Agent, AnthropicAdapter, loadAgentConfig, isDirectExecution } from "../../src/index";

export interface AnthropicExampleOptions {
  model?: string;
  apiKey?: string;
  systemPrompt?: string;
  enableExecutionReporting?: boolean;
}

export function createAnthropicAgent(
  options: AnthropicExampleOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = new AnthropicAdapter({
    anthropicModel: options.model ?? "claude-sonnet-4-6",
    apiKey: options.apiKey,
    systemPrompt: options.systemPrompt,
    enableExecutionReporting: options.enableExecutionReporting,
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "anthropic-agent",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("anthropic_agent");
  void createAnthropicAgent({}, config).run();
}
