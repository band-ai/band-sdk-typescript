import { Agent, OmpACPAdapter, isDirectExecution, loadAgentConfig, type OmpACPAdapterOptions } from "../../src/index";

export type OmpACPExampleOptions = Pick<OmpACPAdapterOptions, "cwd">;

export function createOmpACPAgent(
  options: OmpACPExampleOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = new OmpACPAdapter(options);

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "omp-acp-agent",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("omp_acp_agent");
  void createOmpACPAgent({}, config).run();
}
