/**
 * 05 — Contact management.
 *
 * Demonstrates how to react to platform contact-request events outside the
 * normal LLM tool-calling loop.
 *
 * Three strategies are available via `ContactEventConfig.strategy`:
 *   - "disabled" (default): platform emits no contact events
 *   - "callback": every contact event fires `onEvent(event, tools)`
 *   - "hub_room": contact events are routed to a designated hub room so
 *     the LLM can decide via normal tool calling
 *
 * This example uses `"callback"` to auto-approve every incoming contact
 * request. The agent's LLM still has access to the contact tools
 * (`thenvoi_list_contacts`, `thenvoi_add_contact`, etc.) for everything
 * else.
 *
 * ⚠️  Auto-approving contact requests means *anyone* can connect and start
 * triggering LLM inference. Use a real allowlist / domain check in the
 * callback for production.
 */
import {
  Agent,
  AnthropicAdapter,
  type ContactEvent,
  type ContactEventConfig,
  isDirectExecution,
  loadAgentConfig,
} from "@thenvoi/sdk";
import type { AdapterToolsProtocol } from "@thenvoi/sdk/core";

async function autoApproveContacts(
  event: ContactEvent,
  tools: AdapterToolsProtocol,
): Promise<void> {
  if (event.type !== "contact_request_received") {
    return;
  }
  const request = event.payload;
  console.log("[contact] auto-approving from", request.from_handle ?? request.id);
  // `respondContactRequest` is part of the optional ContactTools surface;
  // the `contacts` capability flag tells us at runtime whether it's wired.
  if (!tools.capabilities.contacts || !tools.respondContactRequest) {
    console.warn("[contact] respondContactRequest is unavailable for this agent");
    return;
  }
  await tools.respondContactRequest({
    action: "approve",
    target: "requestId",
    requestId: request.id,
  });
}

interface ContactAgentOptions {
  model?: string;
  apiKey?: string;
}

export function createContactAgent(
  options: ContactAgentOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = new AnthropicAdapter({
    anthropicModel: options.model ?? "claude-sonnet-4-6",
    apiKey: options.apiKey,
    systemPrompt: [
      "You are a helpful assistant with contact management capabilities.",
      "You can list, add, and remove contacts, and manage contact requests.",
      "Incoming contact requests are auto-approved before you see them.",
    ].join("\n"),
  });

  const contactConfig: ContactEventConfig = {
    strategy: "callback",
    onEvent: autoApproveContacts,
    broadcastChanges: true,
  };

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "anthropic-agent",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    contactConfig,
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("Set ANTHROPIC_API_KEY to run this example.");
  }
  const config = loadAgentConfig("anthropic_agent");
  void createContactAgent({ apiKey }, config).run();
}
