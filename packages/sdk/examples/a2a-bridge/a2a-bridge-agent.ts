/**
 * A2A bridge — connect a remote A2A agent to Thenvoi.
 *
 * The Agent2Agent (A2A) protocol is a JSON-RPC interface for running
 * agents over HTTP/SSE. This adapter takes an A2A endpoint URL and
 * forwards each Thenvoi room message into it; the streamed reply lands
 * back in the room. Use this when someone else has built an agent and
 * exposed it over A2A — you get to add it to a Thenvoi room without
 * rewriting it.
 *
 * For an A2A endpoint that needs API key / bearer auth, see
 * `a2a-bridge-auth.ts`.
 */
import {
  A2AAdapter,
  Agent,
  isDirectExecution,
  loadAgentConfig,
} from "@thenvoi/sdk";

function requireA2ARemoteUrl(optionsRemoteUrl?: string): string {
  const remoteUrl = optionsRemoteUrl ?? process.env.A2A_AGENT_URL;
  if (!remoteUrl) {
    throw new Error(
      "A2A remote URL is required. Set A2A_AGENT_URL or pass options.remoteUrl.",
    );
  }
  return remoteUrl;
}

export function createA2ABridgeAgent(
  options?: { remoteUrl?: string },
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const remoteUrl = requireA2ARemoteUrl(options?.remoteUrl);
  const adapter = new A2AAdapter({
    remoteUrl,
    // Stream A2A `status_update` events back into the Thenvoi room as
    // they arrive instead of waiting for the final message.
    streaming: true,
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "agent-a2a",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("a2a_bridge_agent");
  void createA2ABridgeAgent(undefined, config).run();
}
