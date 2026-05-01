/**
 * 04 — Jerry the mouse (Anthropic).
 *
 * Jerry stays cozy in his hole, watches Tom's tactics, weighs cheese vs.
 * risk, and teases without committing — until the moment he slips up.
 *
 * Pair with `03-tom-agent.ts` running in another terminal.
 */
import {
  Agent,
  AnthropicAdapter,
  isDirectExecution,
  loadAgentConfig,
} from "@thenvoi/sdk";
import { generateJerryPrompt } from "./characters";

export function createJerryAgent(
  options: { model?: string; apiKey?: string } = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = new AnthropicAdapter({
    anthropicModel: options.model ?? "claude-sonnet-4-6",
    apiKey: options.apiKey,
    systemPrompt: generateJerryPrompt("Jerry"),
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "jerry-agent",
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
  const config = loadAgentConfig("jerry_agent");
  console.log("Jerry is cozy in his hole, watching for Tom...");
  void createJerryAgent({ apiKey }, config).run();
}
