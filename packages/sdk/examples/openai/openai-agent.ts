/**
 * OpenAI tool-calling agent.
 *
 * Wires Thenvoi platform tools (send_message, lookup_peers, get_participants,
 * etc.) into an OpenAI chat-completions tool-calling loop. The model decides
 * which tool to call; the adapter turns those calls into platform actions.
 *
 * Pattern stays the same for any tool-calling LLM — see the `anthropic/` and
 * `gemini/` siblings, which differ only in the model wrapper.
 */
import {
  Agent,
  OpenAIAdapter,
  isDirectExecution,
  loadAgentConfig,
} from "@thenvoi/sdk";

interface OpenAIExampleOptions {
  /** Override the default model. */
  model?: string;
  /** OpenAI API key — if omitted, the adapter reads `OPENAI_API_KEY` itself. */
  apiKey?: string;
}

export function createOpenAIAgent(
  options: OpenAIExampleOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  // The adapter handles tool-schema generation, conversation history,
  // function-call→platform-action mapping, and retries. You configure
  // model + key; everything else has sane defaults.
  const adapter = new OpenAIAdapter({
    openAIModel: options.model ?? "gpt-5.5",
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
  // Fail fast with a clear message rather than letting the OpenAI SDK
  // throw a less obvious error deep inside the first turn.
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Set OPENAI_API_KEY to run this example.");
  }

  const config = loadAgentConfig("openai_agent");
  void createOpenAIAgent({ apiKey }, config).run();
}
