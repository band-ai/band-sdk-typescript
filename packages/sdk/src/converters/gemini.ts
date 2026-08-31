import type { HistoryConverter } from "../contracts/protocols";

import { parseToolCall, parseToolResult } from "./shared";

export type GeminiPart =
  | { type: "text"; text: string }
  | { type: "function_call"; id: string; name: string; args: Record<string, unknown> }
  | {
    type: "function_response";
    tool_call_id: string;
    name: string;
    response: { output?: string; error?: string };
  };

export interface GeminiMessage {
  role: "user" | "model";
  parts: GeminiPart[];
}

export type GeminiMessages = GeminiMessage[];

function flushPendingToolCalls(messages: GeminiMessages, pendingToolCalls: GeminiPart[]): void {
  if (pendingToolCalls.length === 0) {
    return;
  }

  messages.push({
    role: "model",
    parts: [...pendingToolCalls],
  });
  pendingToolCalls.length = 0;
}

function flushPendingToolResults(messages: GeminiMessages, pendingToolResults: GeminiPart[]): void {
  if (pendingToolResults.length === 0) {
    return;
  }

  messages.push({
    role: "user",
    parts: [...pendingToolResults],
  });
  pendingToolResults.length = 0;
}

function mergeConsecutiveRoles(messages: GeminiMessages): GeminiMessages {
  if (messages.length <= 1) {
    return messages;
  }

  const merged: GeminiMessages = messages.slice(0, 1);
  for (const message of messages.slice(1)) {
    const previous = merged[merged.length - 1];
    if (previous && previous.role === message.role) {
      previous.parts = [...previous.parts, ...message.parts];
      continue;
    }
    merged.push(message);
  }

  return merged;
}

export class GeminiHistoryConverter implements HistoryConverter<GeminiMessages> {
  private agentName: string;

  public constructor(agentName = "") {
    this.agentName = agentName;
  }

  public setAgentName(name: string): void {
    this.agentName = name;
  }

  public convert(raw: Array<Record<string, unknown>>): GeminiMessages {
    const messages: GeminiMessages = [];
    const pendingToolCalls: GeminiPart[] = [];
    const pendingToolResults: GeminiPart[] = [];

    for (const entry of raw) {
      const messageType = String(entry.message_type ?? "text");
      const content = String(entry.content ?? "");

      if (messageType === "tool_call") {
        flushPendingToolResults(messages, pendingToolResults);
        const parsed = parseToolCall(content);
        if (parsed) {
          pendingToolCalls.push({
            type: "function_call",
            id: parsed.toolCallId,
            name: parsed.name,
            args: parsed.args,
          });
        }
        continue;
      }

      if (messageType === "tool_result") {
        flushPendingToolCalls(messages, pendingToolCalls);
        const parsed = parseToolResult(content);
        if (parsed) {
          pendingToolResults.push({
            type: "function_response",
            tool_call_id: parsed.toolCallId,
            name: parsed.name,
            response: parsed.isError
              ? { error: parsed.output }
              : { output: parsed.output },
          });
        }
        continue;
      }

      if (messageType !== "text") {
        continue;
      }

      const role = String(entry.role ?? "user");
      const senderName = String(entry.sender_name ?? "");
      if (role === "assistant" && senderName === this.agentName) {
        if (pendingToolCalls.length > 0 || pendingToolResults.length > 0) {
          continue;
        }

        flushPendingToolCalls(messages, pendingToolCalls);
        flushPendingToolResults(messages, pendingToolResults);
        messages.push({
          role: "model",
          parts: [{ type: "text", text: content }],
        });
        continue;
      }

      flushPendingToolCalls(messages, pendingToolCalls);
      flushPendingToolResults(messages, pendingToolResults);
      messages.push({
        role: "user",
        parts: [{ type: "text", text: senderName ? `[${senderName}]: ${content}` : content }],
      });
    }

    flushPendingToolCalls(messages, pendingToolCalls);
    flushPendingToolResults(messages, pendingToolResults);
    return mergeConsecutiveRoles(messages);
  }
}
