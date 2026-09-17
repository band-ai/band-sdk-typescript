import { loadAgentConfig, isDirectExecution } from "../../src/index";

import { generateTomPrompt } from "../prompts/characters";

import { createClaudeSdkAgent } from "./01_basic_agent";

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("tom_agent");
  void createClaudeSdkAgent({ customSection: generateTomPrompt("Tom").trim() }, config).run();
}
