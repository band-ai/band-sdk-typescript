import { Agent, CursorACPAdapter, isDirectExecution, loadAgentConfig, type CursorACPAdapterOptions } from "../../src/index";

export type CursorACPExampleOptions = CursorACPAdapterOptions;

export function buildCursorACPExampleAdapter(options: CursorACPExampleOptions = {}): CursorACPAdapter {
  return new CursorACPAdapter(options);
}

export function createCursorACPAgent(
  options: CursorACPExampleOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  return Agent.create({
    adapter: buildCursorACPExampleAdapter(options),
    config: {
      agentId: overrides?.agentId ?? "cursor_acp_agent",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("cursor_acp_agent");
  void createCursorACPAgent({}, config).run();
}
