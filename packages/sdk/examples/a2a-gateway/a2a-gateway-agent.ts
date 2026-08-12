import {
  A2AGatewayAdapter,
  Agent,
  deriveDefaultRestUrl,
  loadAgentConfig,
  isDirectExecution,
} from "../../src/index";
import { FernRestAdapter } from "../../src/rest";
import { BandClient } from "@band-ai/rest-client";

export function createA2AGatewayAgent(
  options?: { port?: number; gatewayUrl?: string; authToken?: string },
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const bandApiKey = overrides?.apiKey ?? "api-key";
  const resolvedRestUrl = overrides?.restUrl
    ?? (overrides?.wsUrl ? deriveDefaultRestUrl(overrides.wsUrl) : undefined);
  const restApi = new FernRestAdapter(
    new BandClient({
      apiKey: bandApiKey,
      ...(resolvedRestUrl ? { baseUrl: resolvedRestUrl } : {}),
    }),
  );

  const adapter = new A2AGatewayAdapter({
    bandRest: restApi,
    port: options?.port,
    gatewayUrl: options?.gatewayUrl,
    authToken: options?.authToken ?? bandApiKey,
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "agent-a2a-gateway",
      apiKey: bandApiKey,
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(resolvedRestUrl ? { restUrl: resolvedRestUrl } : {}),
    },
    linkOptions: { restApi },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("a2a_gateway_agent");
  void createA2AGatewayAgent(undefined, config).run();
}
