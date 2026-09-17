import { Agent, ClaudeSDKAdapter, loadAgentConfig, isDirectExecution } from "../../src/index";

interface ClaudeSdkExampleOptions {
  model?: string;
  cwd?: string;
  customSection?: string;
  enableExecutionReporting?: boolean;
}

export function createClaudeSdkAgent(
  options: ClaudeSdkExampleOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = new ClaudeSDKAdapter({
    model: options.model ?? "claude-sonnet-4-6",
    cwd: options.cwd,
    customSection: options.customSection,
    permissionMode: "acceptEdits",
    enableMcpTools: true,
    enableExecutionReporting: options.enableExecutionReporting,
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "claude-sdk-agent",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("claude_sdk_agent");
  void createClaudeSdkAgent({}, config).run();
}
