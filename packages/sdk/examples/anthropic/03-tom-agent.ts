/**
 * 03 — Tom the cat (Anthropic).
 *
 * Tom uses platform tools to find and invite Jerry, then runs up to 10
 * persuasion attempts to coax Jerry out of his hole. The instant Jerry
 * shows any sign of leaving, Tom pounces.
 *
 * Pair with `04-jerry-agent.ts` running in another terminal to watch the
 * two characters play it out in a Thenvoi room.
 */
import {
  Agent,
  AnthropicAdapter,
  isDirectExecution,
  loadAgentConfig,
} from "@thenvoi/sdk";
import { generateTomPrompt } from "./characters";

export function createTomAgent(
  options: { model?: string; apiKey?: string } = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = new AnthropicAdapter({
    anthropicModel: options.model ?? "claude-sonnet-4-7",
    apiKey: options.apiKey,
    systemPrompt: generateTomPrompt("Tom"),
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "tom-agent",
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
  const config = loadAgentConfig("tom_agent");
  console.log("Tom is on the prowl, looking for Jerry...");
  void createTomAgent({ apiKey }, config).run();
}
