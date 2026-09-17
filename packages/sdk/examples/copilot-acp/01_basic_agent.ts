import {
  Agent,
  CopilotACPAdapter,
  isDirectExecution,
  loadAgentConfig,
  type CopilotACPTcpOptions,
  type CopilotACPStdioOptions,
} from "../../src/index";

export type CopilotACPExampleOptions =
  | Pick<CopilotACPStdioOptions, "cwd">
  | Pick<CopilotACPTcpOptions, "cwd" | "host" | "port">;

export function createCopilotACPAgent(
  options: CopilotACPExampleOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = new CopilotACPAdapter(options);

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "copilot-acp-agent",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("copilot_acp_agent");
  void createCopilotACPAgent({}, config).run();
}
