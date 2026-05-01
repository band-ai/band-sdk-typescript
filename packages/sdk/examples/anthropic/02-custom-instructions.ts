/**
 * 02 — Anthropic agent with custom instructions.
 *
 * Same shape as the basic Anthropic example, but with a detailed system
 * prompt that defines the agent's role and conversation flow. This is the
 * pattern for building specialized agents (support, triage, code review,
 * etc.) without writing a custom adapter.
 *
 * The `customSection` is appended to the SDK's base instructions, so you
 * keep all the platform-tool guidance and just layer your own behavior
 * rules on top.
 */
import {
  Agent,
  AnthropicAdapter,
  isDirectExecution,
  loadAgentConfig,
} from "@thenvoi/sdk";

const SUPPORT_INSTRUCTIONS = `
You are a technical support agent for a software company.

Guidelines:
- Be patient and thorough
- Ask clarifying questions before providing solutions
- Always verify the user's environment before troubleshooting
- Escalate to a human if you cannot resolve the issue

When helping users:
1. First acknowledge their issue
2. Ask for relevant details (OS, version, error messages)
3. Provide step-by-step solutions
4. Confirm the issue is resolved before closing
`;

interface SupportAgentOptions {
  model?: string;
  apiKey?: string;
}

export function createSupportAgent(
  options: SupportAgentOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = new AnthropicAdapter({
    anthropicModel: options.model ?? "claude-sonnet-4-7",
    apiKey: options.apiKey,
    systemPrompt: SUPPORT_INSTRUCTIONS,
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "support-agent",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("Set ANTHROPIC_API_KEY to run this example.");
  }
  const config = loadAgentConfig("support_agent");
  void createSupportAgent({ apiKey }, config).run();
}
