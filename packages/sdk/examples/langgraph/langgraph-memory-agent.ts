import { Agent, LangGraphAdapter, loadAgentConfig, isDirectExecution } from "../../src/index";

const MEMORY_CUSTOM_SECTION = `You are a collaborative assistant that remembers important facts across conversations.

When users share preferences, profile details, or recurring context:
- Store them immediately with \`thenvoi_store_memory\` (prefer \`long_term\` / \`semantic\` / \`user\` / \`organization\`)
- Recall relevant memories with \`thenvoi_list_memories\` before answering
- Supersede outdated memories instead of storing duplicates
- After storing or recalling memory, confirm what you did via \`thenvoi_send_message\`

When the user asks you to store or remember something, call \`thenvoi_store_memory\` for the relevant fact, then reply with \`thenvoi_send_message\`.

Use Thenvoi tools for platform side effects and final replies.`;

export interface LangGraphMemoryExampleOptions {
  /** LangChain-compatible chat model (e.g. `ChatOpenAI` from `@langchain/openai`). */
  llm: unknown;
  model?: string;
}

export function createLangGraphMemoryAgent(
  options: LangGraphMemoryExampleOptions,
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = new LangGraphAdapter({
    llm: options.llm,
    includeMemoryTools: true,
    customSection: MEMORY_CUSTOM_SECTION,
    emitExecutionEvents: true,
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "langgraph-memory-agent",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

async function resolveOpenAiLlm(options: { model?: string; apiKey?: string }): Promise<unknown> {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is required to run the LangGraph memory example. Set it in your environment or pass openaiApiKey in agent_config.yaml.",
    );
  }

  try {
    const { ChatOpenAI } = await import("@langchain/openai");
    return new ChatOpenAI({
      model: options.model ?? "gpt-4o",
      apiKey,
    });
  } catch {
    throw new Error(
      'LangGraph memory example requires @langchain/openai. Install with "pnpm add @langchain/openai @langchain/langgraph @langchain/core".',
    );
  }
}

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("memory_agent");
  const openaiApiKey = typeof config.openai_api_key === "string" ? config.openai_api_key : undefined;
  const model = typeof config.model === "string"
    ? config.model
    : process.env.OPENAI_MODEL;
  const llm = await resolveOpenAiLlm({ model, apiKey: openaiApiKey });
  void createLangGraphMemoryAgent({ llm, model }, config).run();
}
