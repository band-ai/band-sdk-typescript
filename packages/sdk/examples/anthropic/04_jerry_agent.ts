import { loadAgentConfig, isDirectExecution } from "../../src/index";
import { renderSystemPrompt } from "../../src/runtime/prompts";
import { generateJerryPrompt } from "../prompts/characters";

import { createAnthropicAgent } from "./01_basic_agent";

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("jerry_agent");
  void createAnthropicAgent(
    {
      systemPrompt: renderSystemPrompt({ customSection: generateJerryPrompt("Jerry").trim() }),
    },
    config,
  ).run();
}
