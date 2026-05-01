/**
 * Letta-backed Thenvoi agent.
 *
 * Letta is a stateful agent platform with persistent memory across
 * conversations. The adapter pipes each Thenvoi room message into a
 * Letta agent and forwards the reply back into the room.
 *
 * Works with either Letta Cloud (`LETTA_API_KEY`) or a self-hosted Letta
 * instance (`LETTA_BASE_URL`).
 */
import {
  Agent,
  LettaAdapter,
  isDirectExecution,
  loadAgentConfig,
} from "@thenvoi/sdk";
import { ConsoleLogger } from "@thenvoi/sdk/core";

export function createLettaAgent(
  options: {
    /** Override the Letta model name. Letta uses provider-prefixed IDs. */
    model?: string;
    /** Letta Cloud API key. Set this OR `lettaBaseUrl`. */
    lettaApiKey?: string;
    /** Self-hosted Letta server URL. Set this OR `lettaApiKey`. */
    lettaBaseUrl?: string;
  },
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = new LettaAdapter({
    model: options.model ?? "openai/gpt-4o",
    lettaApiKey: options.lettaApiKey,
    lettaBaseUrl: options.lettaBaseUrl,
    logger: new ConsoleLogger(),
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "agent-letta",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: {
      autoSubscribeExistingRooms: true,
    },
  });
}

if (isDirectExecution(import.meta.url)) {
  const lettaApiKey = process.env.LETTA_API_KEY;
  const lettaBaseUrl = process.env.LETTA_BASE_URL;

  // One of cloud / self-hosted must be set — there's no useful default.
  if (!lettaApiKey && !lettaBaseUrl) {
    throw new Error(
      "Set LETTA_API_KEY (cloud) or LETTA_BASE_URL (self-hosted) to run this example.",
    );
  }

  const config = loadAgentConfig("letta_agent");
  console.log("[letta-agent] Starting agent:", config.agentId);
  console.log("[letta-agent] Model:", process.env.LETTA_MODEL ?? "openai/gpt-4o");
  console.log("[letta-agent] Letta target:", lettaBaseUrl ?? "cloud");
  void createLettaAgent(
    {
      model: process.env.LETTA_MODEL,
      lettaApiKey,
      lettaBaseUrl,
    },
    config,
  )
    .run()
    .catch((e) => console.error("[letta-agent] run() error:", e));
}
