import { loadAgentConfig, isDirectExecution } from "../../src/index";
import { renderSystemPrompt } from "../../src/runtime/prompts";

import { generateTomPrompt } from "../prompts/characters";

import { createGeminiAgent } from "./01_basic_agent";

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("tom_agent");
  void createGeminiAgent(
    {
      systemPrompt: renderSystemPrompt({ customSection: generateTomPrompt("Tom").trim() }),
      enableExecutionReporting: true,
    },
    config,
  ).run();
}
