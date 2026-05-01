/**
 * Claude Agent SDK example.
 *
 * Unlike `anthropic/` (which uses the bare Messages API), this adapter wraps
 * the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`). That gives you
 * Claude Code-style behavior: file system access, MCP tool servers, and the
 * full agentic loop — not just one-shot tool calls.
 *
 * Use this when you want the agent to *do work in a repo* (read files, run
 * commands, edit code) on the Thenvoi platform.
 */
import {
  Agent,
  ClaudeSDKAdapter,
  isDirectExecution,
  loadAgentConfig,
} from "@thenvoi/sdk";

interface ClaudeSdkExampleOptions {
  /** Override the default model. */
  model?: string;
  /** Working directory the Claude SDK uses for file operations. Defaults to the process cwd. */
  cwd?: string;
}

export function createClaudeSdkAgent(
  options: ClaudeSdkExampleOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = new ClaudeSDKAdapter({
    model: options.model ?? "claude-sonnet-4-7",
    cwd: options.cwd,
    // `acceptEdits` lets the SDK apply file edits without prompting. Use
    // `default` (interactive) or `bypassPermissions` if you want different
    // gating behavior.
    permissionMode: "acceptEdits",
    // Expose Thenvoi platform tools as MCP tools so the SDK's loop can
    // call them alongside its own filesystem / shell tools.
    enableMcpTools: true,
  });

  return Agent.create({
    adapter,
    config: {
      agentId: overrides?.agentId ?? "claude-sdk-agent",
      apiKey: overrides?.apiKey ?? "api-key",
      ...(overrides?.wsUrl ? { wsUrl: overrides.wsUrl } : {}),
      ...(overrides?.restUrl ? { restUrl: overrides.restUrl } : {}),
    },
    agentConfig: { autoSubscribeExistingRooms: true },
  });
}

if (isDirectExecution(import.meta.url)) {
  const config = loadAgentConfig("claude_sdk_agent");
  void createClaudeSdkAgent({}, config).run();
}
