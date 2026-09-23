import {
  Agent,
  isDirectExecution,
  KiroACPAdapter,
  loadAgentConfig,
  type KiroACPAdapterOptions,
} from "../../src/index";

/** Kiro ACP adapter options (see README for common fields: `cwd`, `customSection`). */
export type KiroACPExampleOptions = KiroACPAdapterOptions;

export function buildKiroACPExampleAdapter(
  options: KiroACPExampleOptions = {},
): KiroACPAdapter {
  return new KiroACPAdapter(options);
}

export function createKiroACPAgent(
  options: KiroACPExampleOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = buildKiroACPExampleAdapter(options);

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "kiro-acp-agent",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("kiro_acp_agent");
  void createKiroACPAgent({}, config).run();
}
