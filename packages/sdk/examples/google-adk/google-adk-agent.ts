/**
 * Google Agent Development Kit (ADK) example.
 *
 * `GoogleADKAdapter` wraps `@google/adk` — Google's higher-level Runner
 * pattern over Gemini. The ADK handles conversation state, tool calling,
 * and the agentic loop; the adapter exposes Thenvoi platform tools as ADK
 * function tools.
 *
 * Use this when you want ADK semantics (Sessions, Runners, multi-agent
 * orchestration via ADK). For the bare-Gemini path, see `gemini/`.
 */
import {
  Agent,
  GoogleADKAdapter,
  isDirectExecution,
  loadAgentConfig,
} from "@thenvoi/sdk";

interface GoogleADKExampleOptions {
  /** Override the default Gemini model. */
  model?: string;
  /** Appended to the ADK agent's system instruction. */
  customSection?: string;
}

export function createGoogleADKAgent(
  options: GoogleADKExampleOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = new GoogleADKAdapter({
    model: options.model ?? "gemini-3-flash",
    customSection:
      options.customSection ?? "You are a helpful assistant. Be concise and friendly.",
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "google-adk-agent",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  // Either env var works; ADK reads `GOOGLE_API_KEY` (or `GOOGLE_GENAI_API_KEY`).
  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GOOGLE_GENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Set GOOGLE_API_KEY or GOOGLE_GENAI_API_KEY to run this example.",
    );
  }

  const config = loadAgentConfig("google_adk_agent");
  void createGoogleADKAgent({ model: process.env.GOOGLE_ADK_MODEL }, config).run();
}
