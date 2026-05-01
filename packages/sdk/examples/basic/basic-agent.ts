/**
 * Basic Thenvoi agent — the smallest possible "echo bot".
 *
 * This file is intentionally tiny so you can read it top to bottom and see
 * exactly what an agent needs to do:
 *   1. Build an adapter that decides how to react to an inbound message.
 *   2. Hand the adapter to `Agent.create` along with your credentials.
 *   3. Call `agent.run()` to connect to the platform and start handling
 *      messages until the process exits.
 *
 * The adapter here uses `GenericAdapter`, which lets you implement
 * message handling as a single async function. For richer behaviors
 * (LLM tool-calling, conversation history, MCP tools) see the other
 * adapter folders in this directory.
 */
import {
  Agent,
  GenericAdapter,
  isDirectExecution,
  loadAgentConfig,
} from "@thenvoi/sdk";

/**
 * Build the agent. Exposed as a function so tests and other examples can
 * construct it without running it; the runner block below is what the CLI
 * actually invokes.
 *
 * `overrides` is here so tests (and the linear-thenvoi example) can pass
 * pre-resolved credentials. In normal use, the runner block below loads
 * credentials from `agent_config.yaml` and passes them in.
 */
export function createBasicAgent(overrides?: {
  agentId?: string;
  apiKey?: string;
  wsUrl?: string;
  restUrl?: string;
}): Agent {
  // The `GenericAdapter` callback is fired for every inbound message in
  // every room this agent is a member of. `tools` exposes the platform
  // actions; here we only use `sendMessage`.
  const adapter = new GenericAdapter(async ({ message, tools }) => {
    // Always @-mention the original sender so the message is delivered
    // back to them (Thenvoi requires at least one mention per message).
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
    // Subscribe to every room this agent is already a member of when we
    // connect, instead of waiting for new invites.
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

// `isDirectExecution` is true only when this file is the entrypoint
// (`tsx examples/basic/basic-agent.ts`). When it's imported by another
// module — e.g. tests — the block is skipped.
if (isDirectExecution(import.meta.url)) {
  // Reads the `basic_agent` entry from `./agent_config.yaml`. See the
  // README in this folder for the yaml shape; if the file is missing or
  // the key isn't there, this throws with a clear "Config file not found"
  // / "Missing required fields" error.
  const config = loadAgentConfig("basic_agent");
  void createBasicAgent(config).run();
}
