/**
 * 03 — Tom the cat (Claude Agent SDK).
 *
 * Pair with `04-jerry-agent.ts`. The Claude SDK gives Tom access to
 * filesystem + shell tools alongside Thenvoi platform tools, but for the
 * game itself only the platform tools are used.
 */
import {
  Agent,
  ClaudeSDKAdapter,
  isDirectExecution,
  loadAgentConfig,
} from "@thenvoi/sdk";
import { generateTomPrompt } from "./characters";

export function createTomAgent(
  options: { model?: string; cwd?: string } = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = new ClaudeSDKAdapter({
    model: options.model ?? "claude-sonnet-4-7",
    cwd: options.cwd,
    permissionMode: "acceptEdits",
    enableMcpTools: true,
    customSection: generateTomPrompt("Tom"),
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "tom-agent",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("tom_agent");
  console.log("Tom is on the prowl, looking for Jerry...");
  void createTomAgent({}, config).run();
}
