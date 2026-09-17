import { readFileSync } from "node:fs";
import path from "node:path";

import { expect } from "vitest";

export const EXAMPLE_ENTRY_SCRIPTS = [
  { file: "examples/openai/01_basic_agent.ts", configKey: "openai_agent" },
  { file: "examples/openai/02_memory_agent.ts", configKey: "memory_agent" },
  { file: "examples/openai/03_tom_agent.ts", configKey: "tom_agent" },
  { file: "examples/openai/04_jerry_agent.ts", configKey: "jerry_agent" },
  { file: "examples/gemini/01_basic_agent.ts", configKey: "gemini_agent" },
  { file: "examples/gemini/02_custom_instructions.ts", configKey: "support_agent" },
  { file: "examples/gemini/03_tom_agent.ts", configKey: "tom_agent" },
  { file: "examples/gemini/04_jerry_agent.ts", configKey: "jerry_agent" },
  { file: "examples/letta/01_basic_agent.ts", configKey: "letta_agent" },
  { file: "examples/letta/02_memory_blocks.ts", configKey: "letta_agent" },
  { file: "examples/letta/03_tom_agent.ts", configKey: "tom_agent" },
  { file: "examples/letta/04_jerry_agent.ts", configKey: "jerry_agent" },
  { file: "examples/copilot-acp/01_basic_agent.ts", configKey: "copilot_acp_agent" },
  { file: "examples/copilot-acp/02_tom_agent.ts", configKey: "tom_agent" },
  { file: "examples/copilot-acp/03_jerry_agent.ts", configKey: "jerry_agent" },
  { file: "examples/omp-acp/01_basic_agent.ts", configKey: "omp_acp_agent" },
  { file: "examples/omp-acp/02_tom_agent.ts", configKey: "tom_agent" },
  { file: "examples/omp-acp/03_jerry_agent.ts", configKey: "jerry_agent" },
  { file: "examples/codex/02_tom_agent.ts", configKey: "tom_agent" },
  { file: "examples/codex/03_jerry_agent.ts", configKey: "jerry_agent" },
  { file: "examples/claude-sdk/02_tom_agent.ts", configKey: "tom_agent" },
  { file: "examples/claude-sdk/03_jerry_agent.ts", configKey: "jerry_agent" },
] as const;

function readExampleSource(relativeToSdkRoot: string): string {
  return readFileSync(path.join(process.cwd(), relativeToSdkRoot), "utf8");
}

export function expectGuardedExampleEntry(relativePath: string, configKey: string): void {
  const source = readExampleSource(relativePath);
  expect(source).toMatch(/isDirectExecution\s*\(\s*import\.meta\.url\s*\)/);
  expect(source).toContain(`loadAgentConfig("${configKey}")`);
  expect(source).toMatch(/if\s*\(\s*isDirectExecution[\s\S]*\.run\s*\(\s*\)/);
}
