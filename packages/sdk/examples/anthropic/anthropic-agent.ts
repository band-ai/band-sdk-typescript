/**
 * Anthropic (Claude) tool-calling agent.
 *
 * Same shape as the OpenAI example: Thenvoi platform tools become Anthropic
 * tool definitions, Claude picks one per turn, the adapter executes it.
 * Switch this for `OpenAIAdapter` or `GeminiAdapter` and the rest of your
 * agent code stays the same.
 */
import {
  Agent,
  AnthropicAdapter,
  isDirectExecution,
  loadAgentConfig,
} from "@thenvoi/sdk";

interface AnthropicExampleOptions {
  /** Override the default model. */
  model?: string;
  /** Anthropic API key — if omitted, the adapter reads `ANTHROPIC_API_KEY` itself. */
  apiKey?: string;
}

export function createAnthropicAgent(
  options: AnthropicExampleOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = new AnthropicAdapter({
    anthropicModel: options.model ?? "claude-sonnet-4-6",
    apiKey: options.apiKey,
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
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("Set ANTHROPIC_API_KEY to run this example.");
  }

  const config = loadAgentConfig("anthropic_agent");
  void createAnthropicAgent({ apiKey }, config).run();
}
