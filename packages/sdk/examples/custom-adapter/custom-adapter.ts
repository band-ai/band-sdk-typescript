import { Agent, SimpleAdapter, type HistoryProvider, type PlatformMessage, loadAgentConfig, isDirectExecution } from "../../src/index";
import type { TurnTools } from "../../src/core";

class EchoAdapter extends SimpleAdapter<HistoryProvider> {
  protected readonly provider = "echo";

  public async onMessage(
    message: PlatformMessage,
    tools: TurnTools,
  ): Promise<void> {
    const sender = [{ id: message.senderId }];
    // Text the adapter writes itself is a notice, not the turn's reply, so the turn is settled on purpose.
    if (message.content.trim() === "/ping") {
      await tools.sendNotice("pong", sender);
      tools.turn.settle();
      return;
    }
    // A send is the turn's reply. A turn that neither replies nor settles is reported as a missing reply.
    await tools.sendMessage(`Custom adapter received: ${message.content}`, sender);
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
