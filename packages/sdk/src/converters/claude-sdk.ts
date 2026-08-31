import type { HistoryConverter } from "../contracts/protocols";
import { findLatestTaskMetadata } from "../adapters/shared/history";
import { asNonEmptyString } from "../core/coercion";

export interface ClaudeSDKSessionState {
  text: string;
  sessionId: string | null;
}

export class ClaudeSDKHistoryConverter implements HistoryConverter<ClaudeSDKSessionState> {
  private agentName = "";

  public constructor(agentName = "") {
    this.agentName = agentName;
  }

  public setAgentName(name: string): void {
    this.agentName = name;
  }

  public convert(raw: Array<Record<string, unknown>>): ClaudeSDKSessionState {
    return {
      text: buildClaudeSdkText(raw, this.agentName),
      sessionId: extractClaudeSessionId(raw),
    };
  }
}

export function extractClaudeSessionId(raw: Array<Record<string, unknown>>): string | null {
  const metadata = findLatestTaskMetadata(
    raw,
    (entry) => (
      typeof entry.claude_sdk_session_id === "string" && entry.claude_sdk_session_id.length > 0
    ) || (
      typeof entry.claude_session_id === "string" && entry.claude_session_id.length > 0
    ),
  );
  const sessionId = metadata?.claude_sdk_session_id ?? metadata?.claude_session_id;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
}

function buildClaudeSdkText(raw: Array<Record<string, unknown>>, agentName: string): string {
  const lines: string[] = [];

  for (const entry of raw) {
    const messageType = String(entry.message_type ?? "text");
    if (messageType === "task") {
      continue;
    }

    const content = asNonEmptyString(entry.content);
    if (!content) {
      continue;
    }

    const role = String(entry.role ?? "user");
    const senderName = asNonEmptyString(entry.sender_name) ?? "Unknown";
    if (messageType === "text") {
      if (role === "assistant" && senderName === agentName) {
        continue;
      }
      lines.push(`[${senderName}]: ${content}`);
      continue;
    }

    if (messageType === "tool_call" || messageType === "tool_result") {
      lines.push(content);
    }
  }

  return lines.join("\n");
}
