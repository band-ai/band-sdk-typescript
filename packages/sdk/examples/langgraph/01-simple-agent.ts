/**
 * 01 — Simple LangGraph agent.
 *
 * The smallest possible LangGraph-backed Thenvoi agent: pass an LLM and a
 * checkpointer, and the adapter handles platform tools, history, and the
 * ReAct loop.
 *
 * Run with:
 *   pnpm --dir packages/sdk exec tsx examples/langgraph/01-simple-agent.ts
 */
import { Agent, LangGraphAdapter, isDirectExecution, loadAgentConfig } from "@thenvoi/sdk";
import { ConsoleLogger } from "@thenvoi/sdk/core";
import { loadChatOpenAI, loadMemorySaver } from "./prompts";

export async function createSimpleAgent(
  options: { model?: string } = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Promise<Agent> {
  const llm = await loadChatOpenAI(options.model ?? "gpt-5.5");
  const checkpointer = await loadMemorySaver();

  const adapter = new LangGraphAdapter({
    llm,
    checkpointer,
    logger: new ConsoleLogger(),
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "simple-agent",
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
  const config = loadAgentConfig("simple_agent");
  void createSimpleAgent({}, config).then((agent) => agent.run());
}
