import { A2AAdapter, Agent, loadAgentConfig, isDirectExecution } from "../../src/index";

import { requireA2ARemoteUrl } from "./01_basic_agent";

export function createA2ABridgeAgentWithAuth(options?: {
  remoteUrl?: string;
  apiKey?: string;
  bearerToken?: string;
}, overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string }): Agent {
  const remoteUrl = requireA2ARemoteUrl(options?.remoteUrl);
  const apiKey = options?.apiKey ?? process.env.A2A_API_KEY;
  const bearerToken = options?.bearerToken ?? process.env.A2A_BEARER_TOKEN;

  const adapter = new A2AAdapter({
    remoteUrl,
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
