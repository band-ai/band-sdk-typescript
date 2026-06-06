/**
 * 02 — Google ADK with custom instructions and execution reporting.
 *
 * Same shape as 01 but with a meatier system prompt and execution
 * reporting turned on so you can see ADK's tool calls land in the room
 * as `task` events.
 */
import {
  Agent,
  GoogleADKAdapter,
  isDirectExecution,
  loadAgentConfig,
} from "@thenvoi/sdk";

const RESEARCH_INSTRUCTIONS = `You are a research assistant specializing in summarizing information.
Always provide sources when possible and be thorough but concise.

When asked about a topic:
1. Identify the key points from the user's question
2. Provide a structured summary
3. Cite any sources or references you mention
4. Offer to dig deeper into specific aspects`;

interface ResearchAgentOptions {
  model?: string;
}

export function createResearchAgent(
  options: ResearchAgentOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = new GoogleADKAdapter({
    // gemini-3-pro-preview: heavier, better for research-style tasks.
    model: options.model ?? "gemini-3-pro-preview",
    customSection: RESEARCH_INSTRUCTIONS,
    enableExecutionReporting: true,
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
  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GOOGLE_GENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Set GOOGLE_API_KEY or GOOGLE_GENAI_API_KEY to run this example.");
  }
  const config = loadAgentConfig("google_adk_agent");
  void createResearchAgent({}, config).run();
}
