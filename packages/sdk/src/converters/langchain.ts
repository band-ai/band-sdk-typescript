import type { HistoryConverter } from "../contracts/protocols";

import { parseToolCall, parseToolResult, type ParsedToolCall } from "./shared";

export type LangChainMessage =
  | { type: "human"; content: string }
  | {
    type: "ai";
    content: string;
    tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  }
  | { type: "tool"; content: string; tool_call_id: string };

export type LangChainMessages = LangChainMessage[];

export class LangChainHistoryConverter implements HistoryConverter<LangChainMessages> {
  private agentName: string;

  public constructor(agentName = "") {
    this.agentName = agentName;
  }

  public setAgentName(name: string): void {
    this.agentName = name;
  }

  public convert(raw: Array<Record<string, unknown>>): LangChainMessages {
    const messages: LangChainMessages = [];
    const pendingToolCalls: ParsedToolCall[] = [];

    for (const entry of raw) {
      const messageType = String(entry.message_type ?? "text");
      const content = String(entry.content ?? "");
      const role = String(entry.role ?? "user");
      const senderName = String(entry.sender_name ?? "");

      if (messageType === "tool_call") {
        const parsed = parseToolCall(content);
        if (parsed) {
          pendingToolCalls.push(parsed);
        }
        continue;
      }

      if (messageType === "tool_result") {
        const parsed = parseToolResult(content);
        if (!parsed) {
          continue;
        }

        const matchingCallIndex = pendingToolCalls.findIndex(
          (toolCall) => toolCall.toolCallId === parsed.toolCallId || toolCall.name === parsed.name,
        );
        const matchingCall = matchingCallIndex >= 0
          ? pendingToolCalls.splice(matchingCallIndex, 1)[0]
          : undefined;
        if (matchingCall) {
          messages.push({
            type: "ai",
            content: "",
            tool_calls: [{
              id: matchingCall.toolCallId,
              name: matchingCall.name,
              args: matchingCall.args,
            }],
          });
        }

        messages.push({
          type: "tool",
          content: parsed.output,
          tool_call_id: parsed.toolCallId,
        });
        continue;
      }

      if (messageType !== "text") {
        continue;
      }

      if (role === "assistant" && senderName === this.agentName) {
        continue;
      }

      messages.push({
        type: "human",
        content: senderName ? `[${senderName}]: ${content}` : content,
      });
    }

    return messages;
  }
}
