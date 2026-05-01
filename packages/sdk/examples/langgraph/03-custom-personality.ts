/**
 * 03 — Custom personality (pirate).
 *
 * Same simple agent shape as 01, but with a pirate personality system-prompt
 * section. Demonstrates how the `customSection` option re-skins the agent
 * without touching tool wiring.
 *
 * Run with:
 *   pnpm --dir packages/sdk exec tsx examples/langgraph/03-custom-personality.ts
 */
import { Agent, LangGraphAdapter, isDirectExecution, loadAgentConfig } from "@thenvoi/sdk";
import {
  PIRATE_PERSONALITY,
  loadChatOpenAI,
  loadMemorySaver,
} from "./prompts";

export async function createPirateAgent(
  options: { model?: string } = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Promise<Agent> {
  const llm = await loadChatOpenAI(options.model ?? "gpt-4o");
  const checkpointer = await loadMemorySaver();

  const adapter = new LangGraphAdapter({
    llm,
    checkpointer,
    customSection: PIRATE_PERSONALITY,
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "pirate-agent",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Set OPENAI_API_KEY to run this example.");
  }
  const config = loadAgentConfig("custom_personality_agent");
  void createPirateAgent({}, config).then((agent) => agent.run());
}
