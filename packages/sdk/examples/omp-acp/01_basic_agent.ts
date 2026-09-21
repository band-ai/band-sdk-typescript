import { Agent, OmpACPAdapter, isDirectExecution, loadAgentConfig, type OmpACPAdapterOptions } from "../../src/index";

/** OMP ACP adapter options (see README for common fields: `cwd`, `customSection`). */
export type OmpACPExampleOptions = OmpACPAdapterOptions;

export function buildOmpACPExampleAdapter(options: OmpACPExampleOptions = {}): OmpACPAdapter {
  return new OmpACPAdapter(options);
}

export function createOmpACPAgent(
  options: OmpACPExampleOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = buildOmpACPExampleAdapter(options);

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
