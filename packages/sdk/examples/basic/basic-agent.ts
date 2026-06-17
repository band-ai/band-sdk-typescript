import { Agent, GenericAdapter, loadAgentConfig, isDirectExecution } from "../../src/index";

export function createBasicAgent(overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string }): Agent {
  const adapter = new GenericAdapter(async ({ message, tools }) => {
    await tools.sendMessage(`Echo: ${message.content}`, [
      { id: message.senderId, handle: message.senderName ?? message.senderType },
    ]);
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "basic-agent",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("basic_agent");
  void createBasicAgent(config).run();
}
