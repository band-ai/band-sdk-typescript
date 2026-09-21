import {
  Agent,
  CopilotACPAdapter,
  isDirectExecution,
  loadAgentConfig,
  type CopilotACPAdapterOptions,
} from "../../src/index";

/** Copilot ACP adapter options (see README for common fields: `cwd`, `customSection`). */
export type CopilotACPExampleOptions = CopilotACPAdapterOptions;

export function buildCopilotACPExampleAdapter(
  options: CopilotACPExampleOptions = {},
): CopilotACPAdapter {
  return new CopilotACPAdapter(options);
}

export function createCopilotACPAgent(
  options: CopilotACPExampleOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = buildCopilotACPExampleAdapter(options);

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
