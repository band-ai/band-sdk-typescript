import { Agent, LangGraphAdapter, isDirectExecution, loadAgentConfig } from "@thenvoi/sdk";
import { ConsoleLogger } from "@thenvoi/sdk/core";
import {
  createLLM,
  createLLMByName,
  generateThinkerPrompt,
} from "./prompts";

/**
 * Thinker agent for the 20 Questions Arena.
 *
 * The Thinker picks a secret word from one of four categories, invites the
 * configured Guesser agents into a room, and answers up to 20 yes/no
 * questions per guesser before revealing the result.
 */
export async function createThinkerAgent(
  options: { model?: string } = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Promise<Agent> {
  const llm = options.model
    ? await createLLMByName(options.model)
    : await createLLM();

  // Lazy-load MemorySaver to keep the dependency optional at import time.
  const { MemorySaver } = await import("@langchain/langgraph");

  const adapter = new LangGraphAdapter({
    llm,
    checkpointer: new MemorySaver(),
    customSection: generateThinkerPrompt("Thinker"),
    emitExecutionEvents: true,
    logger: new ConsoleLogger(),
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "arena-thinker",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

function parseModelArg(): string | undefined {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--model" || arg === "-m") {
      return args[i + 1];
    }
    if (arg.startsWith("--model=")) {
      return arg.slice("--model=".length);
    }
  }
  return undefined;
}

if (isDirectExecution(import.meta.url)) {
  const model = parseModelArg();
  const config = loadAgentConfig("arena_thinker");

  console.log("=".repeat(60));
  console.log("THINKER AGENT STARTING");
  console.log("  agent_id   :", config.agentId);
  console.log("  model flag :", model ?? "(auto-detect)");
  console.log("=".repeat(60));

  void createThinkerAgent({ model }, config).then((agent) => agent.run());
}
