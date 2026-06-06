/**
 * A2A bridge with auth.
 *
 * Same shape as `a2a-bridge-agent.ts`, but the remote A2A endpoint
 * requires an API key, a bearer token, or both. Set the appropriate env
 * vars and the adapter wires them into outbound requests.
 *
 * Use this when:
 *   - The A2A server is behind an API gateway that requires `Authorization`
 *     headers, or
 *   - The A2A server itself implements key-based auth (e.g. an internal
 *     Thenvoi agent exposed as A2A via `a2a-gateway/`).
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

export function createA2ABridgeAgentWithAuth(
  options?: {
    remoteUrl?: string;
    /** Sent as `X-API-Key` header (or whatever the adapter's auth helper does). */
    apiKey?: string;
    /** Sent as `Authorization: Bearer <token>`. */
    bearerToken?: string;
  },
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const remoteUrl = requireA2ARemoteUrl(options?.remoteUrl);
  const apiKey = options?.apiKey ?? process.env.A2A_API_KEY;
  const bearerToken = options?.bearerToken ?? process.env.A2A_BEARER_TOKEN;

  const adapter = new A2AAdapter({
    remoteUrl,
    // Pass whichever auth fields are populated. Both are optional —
    // some endpoints take only one.
    auth: {
      ...(apiKey ? { apiKey } : {}),
      ...(bearerToken ? { bearerToken } : {}),
    },
    streaming: true,
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "agent-a2a-auth",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("a2a_bridge_auth_agent");
  void createA2ABridgeAgentWithAuth(undefined, config).run();
}
