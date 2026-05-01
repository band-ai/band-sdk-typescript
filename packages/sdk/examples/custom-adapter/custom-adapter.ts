/**
 * Custom adapter — write your own message handler from scratch.
 *
 * `SimpleAdapter` is the lowest-level convenient adapter. Subclass it and
 * implement `onMessage` to do whatever you want: call your own model, hit
 * an internal API, run a workflow engine, etc. The only contract is that
 * you eventually call one of the platform tools (`sendMessage`,
 * `sendEvent`, `addParticipant`, …) to put output back into the room.
 *
 * Use this as the starting point when none of the canned adapters
 * (`OpenAIAdapter`, `AnthropicAdapter`, `LangGraphAdapter`, …) match what
 * you actually need.
 */
import {
  Agent,
  SimpleAdapter,
  type HistoryProvider,
  type PlatformMessage,
  type AdapterToolsProtocol,
  isDirectExecution,
  loadAgentConfig,
} from "@thenvoi/sdk";

/**
 * Trivial echo adapter — replies with `Custom adapter received: <msg>`.
 * Replace the body of `onMessage` with your real logic.
 */
class EchoAdapter extends SimpleAdapter<HistoryProvider> {
  public async onMessage(
    message: PlatformMessage,
    tools: AdapterToolsProtocol,
  ): Promise<void> {
    // Always include at least one mention; Thenvoi rejects messages with
    // none. The simplest choice is the original sender's id+handle.
    await tools.sendMessage(`Custom adapter received: ${message.content}`, [
      { id: message.senderId, handle: message.senderName ?? message.senderType },
    ]);
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
