/**
 * ACP client — wrap an existing ACP-compatible agent as a Thenvoi participant.
 *
 * The Agent Client Protocol (ACP) is a JSON-RPC-over-stdio protocol that
 * coding agents (Claude Code, Cursor's agent, etc.) speak. This adapter
 * spawns one of those agent binaries as a subprocess and forwards each
 * Thenvoi room message to it as an ACP `session/prompt`. The streamed
 * `session/update` events come back into the room as Thenvoi events.
 *
 * Default command spawns Claude Code via `@zed-industries/claude-code-acp`.
 * Override with `ACP_CLIENT_COMMAND` to point at a different ACP binary.
 */
import { Agent, isDirectExecution, loadAgentConfig } from "@thenvoi/sdk";
import { ACPClientAdapter } from "@thenvoi/sdk/adapters";

interface ACPClientExampleOptions {
  /** Subprocess to spawn — array (argv) or single string. */
  command?: string | string[];
  /** Working directory the spawned ACP agent runs in. */
  cwd?: string;
}

export function createACPClientAgent(
  options: ACPClientExampleOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = new ACPClientAdapter({
    command: options.command ?? ["npx", "@zed-industries/claude-code-acp"],
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "acp-client-agent",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  // ACP_CLIENT_COMMAND is a space-separated argv (e.g. "my-acp-agent --flag")
  const command = process.env.ACP_CLIENT_COMMAND
    ? process.env.ACP_CLIENT_COMMAND.split(" ").filter(Boolean)
    : undefined;

  const config = loadAgentConfig("acp_client_agent");
  void createACPClientAgent({ command, cwd: process.env.ACP_CLIENT_CWD }, config).run();
}
