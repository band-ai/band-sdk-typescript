import { loadAgentConfig, isDirectExecution } from "../../src/index";
import { renderSystemPrompt } from "../../src/runtime/prompts";

import { createOpenAIAgent, type OpenAIExampleOptions } from "./01_basic_agent";

const PERSONA = `You are a helpful assistant. Use Band memory tools to remember durable facts the user asks you to keep.`;

export function openAIMemoryExampleOptions(
  overrides: Partial<OpenAIExampleOptions> = {},
): OpenAIExampleOptions {
  return {
    model: "gpt-4o",
    includeMemoryTools: true,
    enableExecutionReporting: true,
    systemPrompt: renderSystemPrompt({
      customSection: PERSONA.trim(),
      capabilities: { memory: true },
    }),
    ...overrides,
  };
}

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("memory_agent");
  const openaiApiKey = typeof config.openai_api_key === "string" ? config.openai_api_key : undefined;
  const model = typeof config.model === "string" ? config.model : undefined;

  void createOpenAIAgent(
    openAIMemoryExampleOptions({ model: model ?? "gpt-4o", apiKey: openaiApiKey }),
    config,
  ).run();
}
