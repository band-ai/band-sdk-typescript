import type { HookCallback, HookEvent, Options } from "@anthropic-ai/claude-agent-sdk";
import type { Letta } from "@letta-ai/letta-client/client";
import type { MessageCreateParamsNonStreaming } from "@letta-ai/letta-client/resources/agents/messages";
import type { AssistantMessage, SessionPromptAsyncData } from "@opencode-ai/sdk/v2";

/** Compiled against installed peers and the minimum published packages by the integration checker. */
export function claudeActivityOptions(hook: HookCallback): Pick<Options, "hooks" | "abortController"> {
  const events: HookEvent[] = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PreCompact", "PostCompact"];
  return { abortController: new AbortController(), hooks: Object.fromEntries(events.map((event) => [event, [{ hooks: [hook] }]])) };
}

export async function lettaStepStream(client: Letta, id: string, params: MessageCreateParamsNonStreaming, signal: AbortSignal): Promise<AsyncIterable<unknown>> {
  return await client.agents.messages.create(id, { ...params, streaming: true, stream_tokens: false }, { signal });
}

export function opencodeActivityPrompt(parent: AssistantMessage["parentID"]): NonNullable<SessionPromptAsyncData["body"]> {
  return { messageID: parent, parts: [{ type: "text", text: "prompt" }] };
}
