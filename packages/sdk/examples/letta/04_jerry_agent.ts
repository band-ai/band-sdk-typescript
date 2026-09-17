import { loadAgentConfig, isDirectExecution } from "../../src/index";

import { generateJerryPrompt } from "../prompts/characters";

import { createLettaAgent, resolveLettaCredentials } from "./01_basic_agent";

if (isDirectExecution(import.meta.url)) {
  const { lettaApiKey, lettaBaseUrl } = resolveLettaCredentials();
  const config = loadAgentConfig("jerry_agent");
  void createLettaAgent(
    {
      model: process.env.LETTA_MODEL,
      lettaApiKey,
      lettaBaseUrl,
      customSection: generateJerryPrompt("Jerry").trim(),
    },
    config,
  ).run();
}
