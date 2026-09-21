import { loadAgentConfig, isDirectExecution } from "../../src/index";

import { generateTomPrompt } from "../prompts/characters";

import { createCopilotACPAgent } from "./01_basic_agent";

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("tom_agent");
  void createCopilotACPAgent({ customSection: generateTomPrompt("Tom").trim() }, config).run();
}
