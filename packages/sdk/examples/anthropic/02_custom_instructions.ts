import { loadAgentConfig, isDirectExecution } from "../../src/index";

import { createAnthropicAgent } from "./01_basic_agent";

const SUPPORT_SYSTEM_PROMPT = `You are a technical support agent for a software company.

Guidelines:
- Be patient and thorough
- Ask clarifying questions before providing solutions
- Always verify the user's environment before troubleshooting
- Escalate to a human if you cannot resolve the issue

When helping users:
1. First acknowledge their issue
2. Ask for relevant details (OS, version, error messages)
3. Provide step-by-step solutions
4. Confirm the issue is resolved before closing`;

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("support_agent");
  void createAnthropicAgent(
    {
      systemPrompt: SUPPORT_SYSTEM_PROMPT,
      enableExecutionReporting: true,
    },
    config,
  ).run();
}
