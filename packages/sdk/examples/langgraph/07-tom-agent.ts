/**
 * 07 — Tom the cat (LangGraph + character prompt).
 *
 * Tom uses platform tools to find and invite Jerry, then tries up to 10
 * persuasion attempts to coax Jerry out of his hole. The instant Jerry
 * shows any sign of leaving, Tom pounces.
 *
 * Run with:
 *   pnpm --dir packages/sdk exec tsx examples/langgraph/07-tom-agent.ts
 */
import { Agent, LangGraphAdapter, isDirectExecution, loadAgentConfig } from "@thenvoi/sdk";
import {
  generateTomPrompt,
  loadChatOpenAI,
  loadMemorySaver,
} from "./prompts";

export async function createTomAgent(
  options: { model?: string } = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Promise<Agent> {
  const llm = await loadChatOpenAI(options.model ?? "gpt-4o");
  const checkpointer = await loadMemorySaver();

  const adapter = new LangGraphAdapter({
    llm,
    checkpointer,
    customSection: generateTomPrompt("Tom"),
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "tom-agent",
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
  const config = loadAgentConfig("tom_agent");
  console.log("Tom is on the prowl, looking for Jerry...");
  void createTomAgent({}, config).then((agent) => agent.run());
}
