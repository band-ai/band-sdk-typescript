import { Agent, GeminiAdapter, loadAgentConfig, isDirectExecution } from "../../src/index";
import type { ToolCallingModel } from "../../src/adapters/tool-calling";

export interface GeminiExampleOptions {
  model?: string;
  apiKey?: string;
  systemPrompt?: string;
  includeMemoryTools?: boolean;
  enableExecutionReporting?: boolean;
  maxToolRounds?: number;
  toolCallingModel?: ToolCallingModel;
}

export function buildGeminiExampleAdapter(options: GeminiExampleOptions = {}): GeminiAdapter {
  const modelOptions = options.toolCallingModel
    ? { model: options.toolCallingModel }
    : { geminiModel: options.model ?? "gemini-3-flash-preview", apiKey: options.apiKey };

  return new GeminiAdapter({
    ...modelOptions,
    systemPrompt: options.systemPrompt,
    includeMemoryTools: options.includeMemoryTools,
    enableExecutionReporting: options.enableExecutionReporting,
    maxToolRounds: options.maxToolRounds,
  });
}

export function createGeminiAgent(
  options: GeminiExampleOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = buildGeminiExampleAdapter(options);

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "gemini-agent",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("gemini_agent");
  void createGeminiAgent({}, config).run();
}
