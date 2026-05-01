/**
 * Codex (OpenAI Codex CLI) adapter.
 *
 * Wraps the `@openai/codex-sdk` runtime — an agentic loop that can run
 * shell commands, edit files, and reason iteratively with reasoning effort
 * settings. Counterpart to `claude-sdk/`: same shape (full coding agent
 * over Thenvoi), different model + tool stack.
 */
import {
  Agent,
  CodexAdapter,
  type CodexAdapterConfig,
  isDirectExecution,
  loadAgentConfig,
} from "@thenvoi/sdk";

interface CodexExampleOptions {
  /** Override the default model. */
  model?: string;
  /** Working directory for shell + file ops. Defaults to the process cwd. */
  cwd?: string;
  /** When Codex asks to run a command, what to do — `never` runs without prompting. */
  approvalPolicy?: CodexAdapterConfig["approvalPolicy"];
  /** Sandboxing for shell commands; `workspace-write` allows edits in cwd only. */
  sandboxMode?: CodexAdapterConfig["sandboxMode"];
  /** `minimal` / `low` / `medium` / `high` / `xhigh`. Higher costs more, thinks more. */
  reasoningEffort?: CodexAdapterConfig["reasoningEffort"];
}

export function createCodexAgent(
  options: CodexExampleOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = new CodexAdapter({
    config: {
      model: options.model,
      cwd: options.cwd,
      approvalPolicy: options.approvalPolicy ?? "never",
      sandboxMode: options.sandboxMode ?? "workspace-write",
      reasoningEffort: options.reasoningEffort,
      // These three give you full visibility in the Thenvoi UI:
      enableExecutionReporting: true, // shell + file actions become "task" events
      emitThoughtEvents: true,        // reasoning summary becomes "thought" events
      enableLocalCommands: true,      // let Codex actually run shell commands
    },
  });

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
