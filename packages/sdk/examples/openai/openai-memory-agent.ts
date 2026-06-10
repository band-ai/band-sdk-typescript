/**
 * OpenAI ToolCalling agent with Thenvoi memory tools enabled.
 *
 * Demonstrates `includeMemoryTools: true` on OpenAIAdapter, which exposes
 * memory tool schemas and renders memory enum guidance in the system prompt.
 *
 * Run (from packages/sdk):
 *   pnpm example:openai-memory
 *
 * Requires:
 *   - agent_config.yaml with openai_memory_agent credentials
 *   - OPENAI_API_KEY
 */
import {
  Agent,
  OpenAIAdapter,
  loadAgentConfig,
  isDirectExecution,
} from "../../src/index";
import type { AgentCredentials } from "../../src/config";
import { ConsoleLogger, NoopLogger, type Logger } from "../../src/core/logger";

export const MEMORY_CUSTOM_SECTION =
  "Actively look for durable information worth remembering. " +
  "When a user states a preference, profile detail, standing instruction, " +
  "important project fact, or reusable workflow, call `thenvoi_store_memory` " +
  "before replying. Use memory sparingly: do not store one-off requests, " +
  "temporary chat context, or sensitive information unless the user clearly " +
  "asks you to remember it. After storing a memory, briefly acknowledge what " +
  "you saved and continue helping the user.";

interface OpenAIMemoryExampleOptions {
  model?: string;
  apiKey?: string;
  logger?: Logger;
}

export function createOpenAIMemoryAgent(
  options: OpenAIMemoryExampleOptions = {},
  config?: AgentCredentials,
): Agent {
  const logger = options.logger ?? new NoopLogger();

  const adapter = new OpenAIAdapter({
    openAIModel: options.model ?? "gpt-4o-mini",
    apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
    includeMemoryTools: true,
    customSection: MEMORY_CUSTOM_SECTION,
    logger,
  });

  return Agent.create({
    adapter,
    logger,
    agentConfig: {
      autoSubscribeExistingRooms: true,
    },
    ...(config
      ? { config }
      : {
          agentId: "openai-memory-agent",
          apiKey: "api-key",
        }),
  });
}

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("openai_memory_agent");
  const logger = new ConsoleLogger();

  console.log("[openai-memory-agent] Starting...");
  console.log("[openai-memory-agent] Agent ID:", config.agentId);
  console.log("[openai-memory-agent] REST URL:", config.restUrl ?? "(platform default)");
  console.log("[openai-memory-agent] WS URL:", config.wsUrl ?? "(platform default)");
  console.log("[openai-memory-agent] Model:", process.env.OPENAI_MODEL ?? "gpt-4o-mini");
  console.log("[openai-memory-agent] Memory tools: enabled");
  console.log(
    "[openai-memory-agent] Listening for messages — @mention the agent in a Thenvoi chat.",
  );

  void createOpenAIMemoryAgent({ logger }, config)
    .run()
    .then(() => console.log("[openai-memory-agent] Stopped."))
    .catch((error: unknown) => console.error("[openai-memory-agent] Error:", error));
}
