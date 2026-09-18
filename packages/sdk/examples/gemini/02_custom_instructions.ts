import { loadAgentConfig, isDirectExecution } from "../../src/index";
import { renderSystemPrompt } from "../../src/runtime/prompts";

import { createGeminiAgent, type GeminiExampleOptions } from "./01_basic_agent";

export const GEMINI_SUPPORT_CUSTOM_SECTION = `You are a technical support agent for a software company.

Guidelines:
- Be patient and thorough
- Ask clarifying questions before providing solutions
- Always verify the user's environment before troubleshooting
- Escalate to a human if you cannot resolve the issue`;

export function geminiSupportExampleOptions(
  overrides: Partial<GeminiExampleOptions> = {},
): GeminiExampleOptions {
  return {
    systemPrompt: renderSystemPrompt({ customSection: GEMINI_SUPPORT_CUSTOM_SECTION.trim() }),
    enableExecutionReporting: true,
    ...overrides,
  };
}

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("support_agent");
  void createGeminiAgent(geminiSupportExampleOptions(), config).run();
}
