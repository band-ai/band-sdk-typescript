import type { HistoryConverter } from "../contracts/protocols";

import { parseToolCall, parseToolResult } from "./shared";

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export type AnthropicMessages = AnthropicMessage[];

function flushPendingToolCalls(
  messages: AnthropicMessages,
  pendingToolCalls: AnthropicContentBlock[],
): void {
  if (pendingToolCalls.length === 0) {
    return;
  }

  messages.push({
    role: "assistant",
    content: [...pendingToolCalls],
  });
  pendingToolCalls.length = 0;
}

function flushPendingToolResults(
  messages: AnthropicMessages,
  pendingToolResults: AnthropicContentBlock[],
): void {
  if (pendingToolResults.length === 0) {
    return;
  }

  messages.push({
    role: "user",
    content: [...pendingToolResults],
  });
  pendingToolResults.length = 0;
}

function patchOrphanedToolUses(messages: AnthropicMessages): void {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }

    const toolUseIds = new Map<string, string>();
    for (const block of message.content) {
      if (block.type === "tool_use") {
        toolUseIds.set(block.id, block.name);
      }
    }

    if (toolUseIds.size === 0) {
      continue;
    }

    const nextMessage = messages[index + 1];
    const matchedIds = new Set<string>();
    if (nextMessage?.role === "user" && Array.isArray(nextMessage.content)) {
      for (const block of nextMessage.content) {
        if (block.type === "tool_result" && toolUseIds.has(block.tool_use_id)) {
          matchedIds.add(block.tool_use_id);
        }
      }
    }

    const syntheticResults = [...toolUseIds.entries()]
      .filter(([toolUseId]) => !matchedIds.has(toolUseId))
      .map(([toolUseId]) => ({
        type: "tool_result" as const,
        tool_use_id: toolUseId,
        content: "Error: tool execution was interrupted",
        is_error: true,
      }));

    if (syntheticResults.length === 0) {
      continue;
    }

    if (nextMessage?.role === "user") {
      if (typeof nextMessage.content === "string") {
        nextMessage.content = [
          ...syntheticResults,
          { type: "text", text: nextMessage.content },
        ];
      } else {
        nextMessage.content = [...syntheticResults, ...nextMessage.content];
      }
      continue;
    }

    messages.splice(index + 1, 0, {
      role: "user",
      content: syntheticResults,
    });
    index += 1;
  }
}

export class AnthropicHistoryConverter implements HistoryConverter<AnthropicMessages> {
  private agentName: string;

  public constructor(agentName = "") {
    this.agentName = agentName;
  }

  public setAgentName(name: string): void {
    this.agentName = name;
  }

  public convert(raw: Array<Record<string, unknown>>): AnthropicMessages {
    const messages: AnthropicMessages = [];
    const pendingToolCalls: AnthropicContentBlock[] = [];
    const pendingToolResults: AnthropicContentBlock[] = [];

    for (const entry of raw) {
      const messageType = String(entry.message_type ?? "text");
      const content = String(entry.content ?? "");

      if (messageType === "tool_call") {
        flushPendingToolResults(messages, pendingToolResults);
        const parsed = parseToolCall(content);
        if (parsed) {
          pendingToolCalls.push({
            type: "tool_use",
            id: parsed.toolCallId,
            name: parsed.name,
            input: parsed.args,
          });
        }
        continue;
      }

      if (messageType === "tool_result") {
        flushPendingToolCalls(messages, pendingToolCalls);
        const parsed = parseToolResult(content);
        if (parsed) {
          pendingToolResults.push({
            type: "tool_result",
            tool_use_id: parsed.toolCallId,
            content: parsed.output,
            ...(parsed.isError ? { is_error: true } : {}),
          });
        }
        continue;
      }

      if (messageType !== "text") {
        continue;
      }

      flushPendingToolCalls(messages, pendingToolCalls);
      flushPendingToolResults(messages, pendingToolResults);

      const role = String(entry.role ?? "user");
      const senderName = String(entry.sender_name ?? "");
      if (role === "assistant" && senderName === this.agentName) {
        continue;
      }

      messages.push({
        role: "user",
        content: senderName ? `[${senderName}]: ${content}` : content,
      });
    }

    flushPendingToolCalls(messages, pendingToolCalls);
    flushPendingToolResults(messages, pendingToolResults);
    patchOrphanedToolUses(messages);

    return messages;
  }
}
