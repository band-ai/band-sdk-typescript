/**
 * 02 — Claude SDK with extended thinking.
 *
 * Turns on Claude's "extended thinking" mode (`maxThinkingTokens > 0`) so
 * the model is allowed to reason through hard problems before replying.
 * `enableExecutionReporting: true` surfaces tool calls and thinking
 * progress as Thenvoi `task` events, so the room can watch the agent
 * work — not just its final answer.
 *
 * Use this when the task is genuinely hard (multi-step reasoning, code
 * analysis, planning). For simple lookups, leave thinking off — it costs
 * tokens.
 */
import {
  Agent,
  ClaudeSDKAdapter,
  isDirectExecution,
  loadAgentConfig,
} from "@thenvoi/sdk";

const THOUGHTFUL_INSTRUCTIONS = `You are a thoughtful AI assistant that excels at complex problem-solving.
When faced with challenging questions:
1. Break down the problem into smaller parts
2. Consider multiple approaches
3. Evaluate trade-offs
4. Provide clear, well-reasoned answers`;

interface ThinkingAgentOptions {
  model?: string;
  cwd?: string;
  /** How many tokens Claude is allowed to use for internal reasoning. */
  maxThinkingTokens?: number;
}

export function createThinkingAgent(
  options: ThinkingAgentOptions = {},
  overrides?: { agentId?: string; apiKey?: string; wsUrl?: string; restUrl?: string },
): Agent {
  const adapter = new ClaudeSDKAdapter({
    // `opus` is a family alias the Claude CLI resolves to the latest Opus
    // at runtime. Pin a specific version (`claude-opus-4-6`) if you need
    // determinism across releases.
    model: options.model ?? "opus",
    cwd: options.cwd,
    permissionMode: "acceptEdits",
    enableMcpTools: true,
    customSection: THOUGHTFUL_INSTRUCTIONS,
    maxThinkingTokens: options.maxThinkingTokens ?? 10_000,
    // Stream thinking + tool calls back into the Thenvoi room as events.
    enableExecutionReporting: true,
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
  console.log("Starting Claude SDK agent with extended thinking…");
  console.log("Max thinking tokens: 10000");
  void createThinkingAgent({}, config).run();
}
