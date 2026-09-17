import { loadAgentConfig, isDirectExecution } from "../../src/index";
import { renderSystemPrompt } from "../../src/runtime/prompts";

import { generateJerryPrompt } from "../prompts/characters";

import { createOpenAIAgent } from "./01_basic_agent";

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("jerry_agent");
  void createOpenAIAgent(
    {
      systemPrompt: renderSystemPrompt({ customSection: generateJerryPrompt("Jerry").trim() }),
      enableExecutionReporting: true,
    },
    config,
  ).run();
}
