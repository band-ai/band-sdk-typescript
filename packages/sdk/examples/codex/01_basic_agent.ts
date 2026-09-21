import { Agent, CodexAdapter, type CodexAdapterConfig, loadAgentConfig, isDirectExecution } from "../../src/index";
import type { CodexClientLike } from "../../src/adapters/codex/appServerClient";

export interface CodexExampleOptions {
  model?: string;
  cwd?: string;
  customSection?: string;
  approvalPolicy?: CodexAdapterConfig["approvalPolicy"];
  sandboxMode?: CodexAdapterConfig["sandboxMode"];
  reasoningEffort?: CodexAdapterConfig["reasoningEffort"];
  factory?: () => Promise<CodexClientLike>;
}

export function buildCodexExampleAdapter(options: CodexExampleOptions = {}): CodexAdapter {
  const { factory, ...configOptions } = options;
  return new CodexAdapter({
    factory,
    config: {
      model: configOptions.model,
      cwd: configOptions.cwd,
      customSection: configOptions.customSection,
      approvalPolicy: configOptions.approvalPolicy ?? "never",
      sandboxMode: configOptions.sandboxMode ?? "workspace-write",
      reasoningEffort: configOptions.reasoningEffort,
      enableExecutionReporting: true,
      emitThoughtEvents: true,
      enableLocalCommands: true,
    },
  });
}

export function createCodexAgent(
  options: CodexExampleOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = buildCodexExampleAdapter(options);

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "codex-agent",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("codex_agent");
  void createCodexAgent({}, config).run();
}
