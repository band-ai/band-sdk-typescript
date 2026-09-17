import { loadAgentConfig, isDirectExecution } from "../../src/index";

import { generateJerryPrompt } from "../prompts/characters";

import { createCodexAgent } from "./01_basic_agent";

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("jerry_agent");
  void createCodexAgent({ customSection: generateJerryPrompt("Jerry").trim() }, config).run();
}
