import { Agent, LangGraphAdapter, loadAgentConfig, isDirectExecution } from "../../src/index";

// Behavioural guidance only — kept short on purpose. The valid memory field
// values (system/type/segment/scope) and common patterns are appended
// automatically by the SDK's type-derived "Memory Tools" section when
// `includeMemoryTools` is enabled, so they are never hardcoded here.
const MEMORY_CUSTOM_SECTION = `You remember facts across conversations using the memory tools.

- Memory is an action: the only way to remember is to call \`thenvoi_store_memory\`.
  Never claim you remembered, stored, or noted something unless you called it this turn.
- When the user shares a preference or fact, call \`thenvoi_store_memory\` (use the field
  values from the Memory Tools section), then confirm with \`thenvoi_send_message\`.
- Store selectively: only durable facts (preferences, profile details, standing
  instructions, project facts). Skip one-off requests, transient chat context, and
  sensitive information unless the user explicitly asks you to remember it.
- Before answering questions about the user, call \`thenvoi_list_memories\` and answer
  from the results; use \`thenvoi_supersede_memory\` instead of storing duplicates.`;

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
