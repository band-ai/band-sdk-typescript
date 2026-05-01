/**
 * 04 — Jerry the mouse (Claude Agent SDK).
 *
 * Pair with `03-tom-agent.ts` running in another terminal.
 */
import {
  Agent,
  ClaudeSDKAdapter,
  isDirectExecution,
  loadAgentConfig,
} from "@thenvoi/sdk";
import { generateJerryPrompt } from "./characters";

export function createJerryAgent(
  options: { model?: string; cwd?: string } = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = new ClaudeSDKAdapter({
    model: options.model ?? "claude-sonnet-4-7",
    cwd: options.cwd,
    permissionMode: "acceptEdits",
    enableMcpTools: true,
    customSection: generateJerryPrompt("Jerry"),
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "jerry-agent",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("jerry_agent");
  console.log("Jerry is cozy in his hole, watching for Tom...");
  void createJerryAgent({}, config).run();
}
