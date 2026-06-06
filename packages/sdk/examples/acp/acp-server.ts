/**
 * ACP server — Thenvoi as an Agent Client Protocol agent.
 *
 * The Agent Client Protocol (ACP) is a JSON-RPC-over-stdio protocol that
 * editors (Zed, Cursor, JetBrains, Neovim) speak to coding agents.
 *
 * This script makes the Thenvoi platform itself act as an ACP agent: the
 * editor sends a prompt over stdio, the SDK posts it into a Thenvoi room,
 * and replies from any peer in that room stream back to the editor as
 * `session/update` notifications.
 *
 * In effect: every Thenvoi peer becomes available to your editor as one
 * synthetic ACP agent.
 */
import {
  Agent,
  deriveDefaultRestUrl,
  isDirectExecution,
  loadAgentConfig,
} from "@thenvoi/sdk";
import { ACPServer, ThenvoiACPServerAdapter } from "@thenvoi/sdk/adapters";
import { FernRestAdapter } from "@thenvoi/sdk/rest";
import { ThenvoiClient } from "@thenvoi/rest-client";

export interface ACPServerExampleResult {
  agent: Agent;
  server: ACPServer;
}

export function createACPServerExample(
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): ACPServerExampleResult {
  const thenvoiApiKey = overrides?.apiKey ?? "api-key";
  const resolvedRestUrl =
    overrides?.restUrl ?? (overrides?.wsUrl ? deriveDefaultRestUrl(overrides.wsUrl) : undefined);

  // The ACP server adapter needs a direct REST client to look up peers
  // and route editor prompts. We share it with the Agent runtime via
  // `linkOptions` below so they don't open separate clients.
  const restApi = new FernRestAdapter(
    new ThenvoiClient({
      apiKey: thenvoiApiKey,
      ...(resolvedRestUrl ? { baseUrl: resolvedRestUrl } : {}),
    }),
  );

  const adapter = new ThenvoiACPServerAdapter({ thenvoiRest: restApi });

  // ACPServer owns the JSON-RPC + stdio transport and dispatches the ACP
  // protocol calls (`initialize`, `session/new`, `session/prompt`, …) to
  // the adapter.
  const server = new ACPServer(adapter);

  const agent = Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "acp-server-agent",
      apiKey: thenvoiApiKey,
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(resolvedRestUrl ? { restUrl: resolvedRestUrl } : {}),
    },
    linkOptions: { restApi },
    // ACP sessions are scoped per editor session, so we don't auto-join
    // existing rooms — the editor explicitly opens a session and
    // implicitly creates a room for it.
    agentConfig: { autoSubscribeExistingRooms: false },
  });

  return { agent, server };
}

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("acp_server_agent");
  const { agent, server } = createACPServerExample(config);

  // The editor talks over stdin/stdout, but we *also* need a live Thenvoi
  // WebSocket so peer responses can stream back. Order matters: start the
  // Thenvoi connection first (non-blocking), then attach to stdio (blocks
  // until the editor disconnects), then clean up.
  void (async () => {
    await agent.start();
    try {
      const connection = await server.connectStdio();
      await connection.closed;
    } finally {
      await agent.stop();
    }
  })();
}
