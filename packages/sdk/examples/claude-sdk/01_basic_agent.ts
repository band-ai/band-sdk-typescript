import { Agent, ClaudeSDKAdapter, loadAgentConfig, isDirectExecution } from "../../src/index";
import type { ClaudeSDKQuery } from "../../src/adapters/claude-sdk/ClaudeSDKAdapter";

export interface ClaudeSdkExampleOptions {
  model?: string;
  cwd?: string;
  customSection?: string;
  enableExecutionReporting?: boolean;
  queryFn?: ClaudeSDKQuery;
}

export function buildClaudeSdkExampleAdapter(options: ClaudeSdkExampleOptions = {}): ClaudeSDKAdapter {
  return new ClaudeSDKAdapter({
    model: options.model ?? "claude-sonnet-4-6",
    cwd: options.cwd,
    customSection: options.customSection,
    queryFn: options.queryFn,
    permissionMode: "acceptEdits",
    enableMcpTools: true,
    enableExecutionReporting: options.enableExecutionReporting,
  });
}

export function createClaudeSdkAgent(
  options: ClaudeSdkExampleOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = buildClaudeSdkExampleAdapter(options);

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
