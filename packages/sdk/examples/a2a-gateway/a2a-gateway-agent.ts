/**
 * A2A gateway — expose Thenvoi peers as A2A endpoints.
 *
 * Inverse of `a2a-bridge/`. Where the bridge brings a remote A2A agent
 * *into* a Thenvoi room, the gateway publishes existing Thenvoi peers
 * *out* as A2A endpoints other tools (Claude Code, an A2A client, another
 * Thenvoi bridge, etc.) can call.
 *
 * The gateway:
 *   - connects to Thenvoi as a platform agent
 *   - serves an A2A JSON-RPC + SSE endpoint on the chosen port
 *   - forwards inbound A2A turns to the matching Thenvoi peer
 *   - streams Thenvoi peer events back to the A2A caller
 */
import {
  A2AGatewayAdapter,
  Agent,
  deriveDefaultRestUrl,
  isDirectExecution,
  loadAgentConfig,
} from "@thenvoi/sdk";
import { FernRestAdapter } from "@thenvoi/sdk/rest";
import { ThenvoiClient } from "@thenvoi/rest-client";

export function createA2AGatewayAgent(
  options?: { port?: number; gatewayUrl?: string; authToken?: string },
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const thenvoiApiKey = overrides?.apiKey ?? "api-key";
  const resolvedRestUrl =
    overrides?.restUrl ?? (overrides?.wsUrl ? deriveDefaultRestUrl(overrides.wsUrl) : undefined);

  // The gateway needs direct REST access (not just the WebSocket) to look
  // up peer metadata, so we build a REST client and inject it into both
  // the adapter and the Agent's link options below.
  const restApi = new FernRestAdapter(
    new ThenvoiClient({
      apiKey: thenvoiApiKey,
      ...(resolvedRestUrl ? { baseUrl: resolvedRestUrl } : {}),
    }),
  );

  const adapter = new A2AGatewayAdapter({
    thenvoiRest: restApi,
    port: options?.port,
    gatewayUrl: options?.gatewayUrl,
    // Inbound A2A callers must present this token. Defaults to the Thenvoi
    // API key — fine for trusted networks; pin a separate secret for prod.
    authToken: options?.authToken ?? thenvoiApiKey,
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "agent-a2a-gateway",
      apiKey: thenvoiApiKey,
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(resolvedRestUrl ? { restUrl: resolvedRestUrl } : {}),
    },
    linkOptions: { restApi },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("a2a_gateway_agent");
  const port = process.env.GATEWAY_PORT ? Number(process.env.GATEWAY_PORT) : undefined;
  const gatewayUrl = process.env.GATEWAY_URL;
  const authToken = process.env.A2A_GATEWAY_AUTH_TOKEN;
  void createA2AGatewayAgent({ port, gatewayUrl, authToken }, config).run();
}
