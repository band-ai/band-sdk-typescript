import { Agent, SimpleAdapter, type HistoryProvider, type PlatformMessage, loadAgentConfig, isDirectExecution } from "../../src/index";
import type { AdapterToolsProtocol } from "../../src/core";

class EchoAdapter extends SimpleAdapter<HistoryProvider> {
  public async onMessage(
    message: PlatformMessage,
    tools: AdapterToolsProtocol,
  ): Promise<void> {
    await tools.sendMessage(`Custom adapter received: ${message.content}`);
  }
}

export function createCustomAdapterAgent(overrides?: {
  agentId?: string;
  apiKey?: string;
  wsUrl?: string;
  restUrl?: string;
}): Agent {
  return Agent.create({
    adapter: new EchoAdapter(),
    config: {
      agentId: overrides?.agentId ?? "agent-1",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("custom_adapter_agent");
  void createCustomAdapterAgent(config).run();
}
