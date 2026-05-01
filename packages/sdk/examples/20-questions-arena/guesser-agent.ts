import { Agent, LangGraphAdapter, isDirectExecution, loadAgentConfig } from "@thenvoi/sdk";
import { ConsoleLogger } from "@thenvoi/sdk/core";
import {
  createLLM,
  createLLMByName,
  generateGuesserPrompt,
} from "./prompts";

/**
 * Guesser agent for the 20 Questions Arena.
 *
 * The Guesser is invited into a room by the Thinker, asks strategic yes/no
 * questions, and tries to guess the secret word within 20 questions. Each
 * guesser plays an independent parallel game; multiple guessers may share
 * the room without coordinating.
 */
export async function createGuesserAgent(
  options: { model?: string } = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Promise<Agent> {
  const llm = options.model
    ? await createLLMByName(options.model)
    : await createLLM();

  const { MemorySaver } = await import("@langchain/langgraph");

  const adapter = new LangGraphAdapter({
    llm,
    checkpointer: new MemorySaver(),
    customSection: generateGuesserPrompt("Guesser"),
    emitExecutionEvents: true,
    logger: new ConsoleLogger(),
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "arena-guesser",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

interface GuesserCliArgs {
  configKey: string;
  model?: string;
}

function parseGuesserArgs(): GuesserCliArgs {
  const args = process.argv.slice(2);
  let configKey = "arena_guesser";
  let model: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--config" || arg === "-c") {
      configKey = args[i + 1] ?? configKey;
      i += 1;
    } else if (arg.startsWith("--config=")) {
      configKey = arg.slice("--config=".length);
    } else if (arg === "--model" || arg === "-m") {
      model = args[i + 1];
      i += 1;
    } else if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
    }
  }

  return { configKey, model };
}

if (isDirectExecution(import.meta.url)) {
  const { configKey, model } = parseGuesserArgs();
  const config = loadAgentConfig(configKey);

  console.log("=".repeat(60));
  console.log("GUESSER AGENT STARTING");
  console.log("  config key :", configKey);
  console.log("  agent_id   :", config.agentId);
  console.log("  model flag :", model ?? "(auto-detect)");
  console.log("=".repeat(60));

  void createGuesserAgent({ model }, config).then((agent) => agent.run());
}
