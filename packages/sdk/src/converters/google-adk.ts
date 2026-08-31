import { findLatestTaskMetadata } from "../adapters/shared/history";

import { parseToolCall, parseToolResult } from "./shared";

export interface GoogleADKMessage {
  role: "user" | "model";
  content: string | Array<Record<string, unknown>>;
}

export type GoogleADKMessages = GoogleADKMessage[];

function appendToolCalls(
  messages: GoogleADKMessages,
  pendingToolCalls: Array<Record<string, unknown>>,
): void {
  if (pendingToolCalls.length === 0) {
    return;
  }

  messages.push({
    role: "model",
    content: [...pendingToolCalls],
  });
  pendingToolCalls.length = 0;
}

function appendToolResults(
  messages: GoogleADKMessages,
  pendingToolResults: Array<Record<string, unknown>>,
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

function patchOrphanedToolCalls(messages: GoogleADKMessages): void {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.role !== "model" || !Array.isArray(message.content)) {
      continue;
    }

    const callNames = new Map<string, string>();
    for (const block of message.content) {
      if (
        block.type === "function_call"
        && typeof block.id === "string"
        && block.id.length > 0
      ) {
        callNames.set(block.id, typeof block.name === "string" ? block.name : "");
      }
    }

    if (callNames.size === 0) {
      continue;
    }

    const nextMessage = messages[index + 1];
    const matchedIds = new Set<string>();
    if (nextMessage?.role === "user" && Array.isArray(nextMessage.content)) {
      for (const block of nextMessage.content) {
        if (
          block.type === "function_response"
          && typeof block.tool_call_id === "string"
          && callNames.has(block.tool_call_id)
        ) {
          matchedIds.add(block.tool_call_id);
        }
      }
    }

    const orphanedIds = [...callNames.keys()].filter((toolCallId) => !matchedIds.has(toolCallId));
    if (orphanedIds.length === 0) {
      continue;
    }

    const syntheticResponses = orphanedIds.map((toolCallId) => ({
      type: "function_response",
      tool_call_id: toolCallId,
      name: callNames.get(toolCallId) ?? "",
      output: "Error: tool execution was interrupted",
      is_error: true,
    }));

    if (nextMessage?.role === "user") {
      if (typeof nextMessage.content === "string") {
        nextMessage.content = [
          ...syntheticResponses,
          { type: "text", text: nextMessage.content },
        ];
      } else if (Array.isArray(nextMessage.content)) {
        nextMessage.content = [...syntheticResponses, ...nextMessage.content];
      }
      continue;
    }

    messages.splice(index + 1, 0, {
      role: "user",
      content: syntheticResponses,
    });
    index += 1;
  }
}

export class GoogleADKHistoryConverter {
  private agentName = "";

  public constructor(agentName = "") {
    this.agentName = agentName;
  }

  public setAgentName(name: string): void {
    this.agentName = name;
  }

  public convert(raw: Array<Record<string, unknown>>): GoogleADKMessages {
    const messages: GoogleADKMessages = [];
    const pendingToolCalls: Array<Record<string, unknown>> = [];
    const pendingToolResults: Array<Record<string, unknown>> = [];

    for (const entry of raw) {
      const messageType = String(entry.message_type ?? "text");
      const content = String(entry.content ?? "");

      if (messageType === "tool_call") {
        appendToolResults(messages, pendingToolResults);
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
        appendToolCalls(messages, pendingToolCalls);
        const parsed = parseToolResult(content);
        if (parsed) {
          pendingToolResults.push({
            type: "function_response",
            tool_call_id: parsed.toolCallId,
            name: parsed.name,
            output: parsed.output,
            ...(parsed.isError ? { is_error: true } : {}),
          });
        }
        continue;
      }

      if (messageType === "thought" || messageType === "error") {
        continue;
      }

      appendToolCalls(messages, pendingToolCalls);
      appendToolResults(messages, pendingToolResults);

      const senderName = String(entry.sender_name ?? "");
      const role = String(entry.role ?? "user");
      if (role === "assistant" && senderName === this.agentName) {
        continue;
      }

      messages.push({
        role: "user",
        content: senderName ? `[${senderName}]: ${content}` : content,
      });
    }

    appendToolCalls(messages, pendingToolCalls);
    appendToolResults(messages, pendingToolResults);
    patchOrphanedToolCalls(messages);

    return messages;
  }
}

export function extractGoogleAdkSessionId(
  raw: Array<Record<string, unknown>>,
): string | null {
  const metadata = findLatestTaskMetadata(
    raw,
    (entry) => typeof entry.google_adk_session_id === "string" && entry.google_adk_session_id.length > 0,
  );
  const sessionId = metadata?.google_adk_session_id;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
}
