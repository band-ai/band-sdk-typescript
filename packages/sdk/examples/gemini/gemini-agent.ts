/**
 * Google Gemini tool-calling agent.
 *
 * Thenvoi platform tools become Gemini function declarations; Gemini picks
 * one per turn and the adapter executes it. Same overall shape as the
 * `openai/` and `anthropic/` examples — only the adapter and key change.
 */
import {
  Agent,
  GeminiAdapter,
  isDirectExecution,
  loadAgentConfig,
} from "@thenvoi/sdk";

interface GeminiExampleOptions {
  /** Override the default model. */
  model?: string;
  /** Gemini API key — if omitted, the adapter reads `GEMINI_API_KEY` / `GOOGLE_API_KEY` itself. */
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
  // Either env var name works; some tooling sets `GOOGLE_API_KEY`, the
  // Gemini docs use `GEMINI_API_KEY`. Pick whichever is set.
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("Set GEMINI_API_KEY or GOOGLE_API_KEY to run this example.");
  }

  const config = loadAgentConfig("gemini_agent");
  void createGeminiAgent({ apiKey }, config).run();
}
