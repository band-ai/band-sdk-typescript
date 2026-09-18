import { loadAgentConfig, isDirectExecution } from "../../src/index";

import { generateJerryPrompt } from "../prompts/characters";

import { createOmpACPAgent } from "./01_basic_agent";

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("jerry_agent");
  void createOmpACPAgent({ customSection: generateJerryPrompt("Jerry").trim() }, config).run();
}
