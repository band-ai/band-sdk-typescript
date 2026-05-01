/**
 * 02 — Claude SDK with extended thinking effort.
 *
 * Sets `effort: "high"` so the underlying Claude Agent SDK is allowed to
 * reason through hard problems before replying. `enableExecutionReporting:
 * true` surfaces tool calls and thinking progress as Thenvoi `task`
 * events, so the room can watch the agent work — not just its final
 * answer.
 *
 * Effort levels:
 *   - "low"    — minimal thinking, fastest responses
 *   - "medium" — moderate thinking
 *   - "high"   — deep reasoning (default for non-trivial work)
 *   - "max"    — maximum effort, Opus-only
 *
 * Use this when the task is genuinely hard (multi-step reasoning, code
 * analysis, planning). For simple lookups, leave `effort` unset.
 */
import {
  Agent,
  ClaudeSDKAdapter,
  type ClaudeEffortLevel,
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
  /** Reasoning effort: "low" / "medium" / "high" / "max" (Opus-only). */
  effort?: ClaudeEffortLevel;
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
    effort: options.effort ?? "high",
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
  console.log("Starting Claude SDK agent with effort=high…");
  void createThinkingAgent({}, config).run();
}
