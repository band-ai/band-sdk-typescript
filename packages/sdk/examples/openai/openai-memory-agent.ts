import { Agent, OpenAIAdapter, loadAgentConfig, isDirectExecution } from "../../src/index";
import { renderSystemPrompt } from "../../src/runtime/prompts";

// Memory-enabled OpenAI agent example.
//
// To add memory to your own OpenAI adapter, do three things:
// 1. Set `includeMemoryTools: true` — registers thenvoi_* memory tools with the LLM.
// 2. Pass a `systemPrompt` built with `renderSystemPrompt({ customSection, capabilities: { memory: true } })`.
//    Your customSection holds behavioural guidance; the SDK appends the Memory Tools field reference.
// 3. Optionally set `enableExecutionReporting: true` — surfaces tool calls in the chat room.
//
// Run: pnpm --filter @thenvoi/sdk exec tsx examples/openai/openai-memory-agent.ts
// Config: `memory_agent` block in agent_config.yaml (Thenvoi creds + optional openai_api_key/model).

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

export interface OpenAIMemoryExampleOptions {
  model?: string;
  apiKey?: string;
}

export function createOpenAIMemoryAgent(
  options: OpenAIMemoryExampleOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = new OpenAIAdapter({
    openAIModel: options.model ?? "gpt-4o",
    apiKey: options.apiKey,
    includeMemoryTools: true, // exposes thenvoi_store_memory, thenvoi_list_memories, etc.
    enableExecutionReporting: true, // optional: show tool activity in chat
    systemPrompt: renderSystemPrompt({
      customSection: MEMORY_CUSTOM_SECTION,
      capabilities: { memory: true }, // appends SDK Memory Tools section to the prompt
    }),
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "openai-memory-agent",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("memory_agent");
  const openaiApiKey = typeof config.openai_api_key === "string" ? config.openai_api_key : undefined;
  const model = typeof config.model === "string"
    ? config.model
    : process.env.OPENAI_MODEL;
  void createOpenAIMemoryAgent({ model, apiKey: openaiApiKey }, config).run();
}
