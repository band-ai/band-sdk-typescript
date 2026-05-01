/**
 * 08 — Jerry the mouse (LangGraph + character prompt).
 *
 * Jerry stays cozy in his hole, watches Tom's tactics, weighs cheese vs.
 * risk, and teases without committing — until the moment he slips up.
 *
 * Run with:
 *   pnpm --dir packages/sdk exec tsx examples/langgraph/08-jerry-agent.ts
 */
import { Agent, LangGraphAdapter, isDirectExecution, loadAgentConfig } from "@thenvoi/sdk";
import {
  generateJerryPrompt,
  loadChatOpenAI,
  loadMemorySaver,
} from "./prompts";

export async function createJerryAgent(
  options: { model?: string } = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Promise<Agent> {
  const llm = await loadChatOpenAI(options.model ?? "gpt-4o");
  const checkpointer = await loadMemorySaver();

  const adapter = new LangGraphAdapter({
    llm,
    checkpointer,
    customSection: generateJerryPrompt("Jerry"),
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "jerry-agent",
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
  const config = loadAgentConfig("jerry_agent");
  console.log("Jerry is cozy in his hole, watching for Tom...");
  void createJerryAgent({}, config).then((agent) => agent.run());
}
