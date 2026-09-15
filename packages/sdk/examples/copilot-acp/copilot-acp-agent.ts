import {
  Agent,
  CopilotACPAdapter,
  isDirectExecution,
  loadAgentConfig,
} from "../../src/index";

export interface CopilotACPExampleOptions {
  host?: string;
  port?: number;
  cwd?: string;
}

export function createCopilotACPAgent(
  options: CopilotACPExampleOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = options.host === undefined && options.port === undefined
    ? new CopilotACPAdapter({ cwd: options.cwd })
    : new CopilotACPAdapter({ host: options.host!, port: options.port!, cwd: options.cwd });

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
