import { loadAgentConfig, isDirectExecution } from "../../src/index";

import { createLettaAgent, resolveLettaCredentials } from "./01_basic_agent";

export const LETTA_EXAMPLE_MEMORY_BLOCKS = [
  { label: "human", value: "The user's name is Alex. They prefer concise answers." },
  { label: "persona", value: "You are a friendly assistant integrated with Band chat." },
] as const;

export function lettaMemoryBlocksExampleOptions(
  creds: { lettaApiKey?: string; lettaBaseUrl?: string },
): Parameters<typeof createLettaAgent>[0] {
  return {
    model: process.env.LETTA_MODEL,
    ...creds,
    memoryBlocks: [...LETTA_EXAMPLE_MEMORY_BLOCKS],
    emitReasoningEvents: true,
  };
}

if (isDirectExecution(import.meta.url)) {
  const creds = resolveLettaCredentials();
  const config = loadAgentConfig("letta_agent");
  void createLettaAgent(lettaMemoryBlocksExampleOptions(creds), config).run();
}
