import { Agent, OpenAIAdapter, loadAgentConfig, isDirectExecution } from "../../src/index";
import { renderSystemPrompt } from "../../src/runtime/prompts";

// Memory-enabled OpenAI agent example.
//
// To add memory to your own OpenAI adapter, do three things:
// 1. Set `includeMemoryTools: true` — registers thenvoi_* memory tools with the LLM.
// 2. Pass a `systemPrompt` built with `renderSystemPrompt({ customSection, capabilities: { memory: true } })`.
//    Your customSection is just your agent's normal persona; the SDK appends the Memory Tools section.
// 3. Optionally set `enableExecutionReporting: true` — surfaces tool calls in the chat room.
//
// Run: pnpm --filter @thenvoi/sdk exec tsx examples/openai/openai-memory-agent.ts
// Config: `memory_agent` block in agent_config.yaml (Thenvoi creds + optional openai_api_key/model).

// Your own agent persona — just your normal instructions, with nothing about
// memory in here. The "Memory Tools" section (tool overview, valid field
// values, and scope guidance) is appended automatically by the SDK when
// `includeMemoryTools` is enabled, so a plain persona like this works fine.
const MEMORY_CUSTOM_SECTION = `You are a helpful assistant.`;

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
