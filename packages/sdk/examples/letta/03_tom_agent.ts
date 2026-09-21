import { loadAgentConfig, isDirectExecution } from "../../src/index";

import { generateTomPrompt } from "../prompts/characters";

import { createLettaAgent, resolveLettaCredentials } from "./01_basic_agent";

if (isDirectExecution(import.meta.url)) {
  const { lettaApiKey, lettaBaseUrl } = resolveLettaCredentials();
  const config = loadAgentConfig("tom_agent");
  void createLettaAgent(
    {
      model: process.env.LETTA_MODEL,
      lettaApiKey,
      lettaBaseUrl,
      customSection: generateTomPrompt("Tom").trim(),
    },
    config,
  ).run();
}
