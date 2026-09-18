import { loadAgentConfig, isDirectExecution } from "../../src/index";

import { generateJerryPrompt } from "../prompts/characters";

import { createClaudeSdkAgent } from "./01_basic_agent";

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("jerry_agent");
  void createClaudeSdkAgent({ customSection: generateJerryPrompt("Jerry").trim() }, config).run();
}
