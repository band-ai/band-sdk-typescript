import type { HistoryConverter } from "../contracts/protocols";
import { findLatestTaskMetadata } from "../adapters/shared/history";
import { asOptionalString, parseToolCall, parseToolResult } from "./shared";

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

    const content = asOptionalString(entry.content);
    if (!content) {
      continue;
    }

    const role = String(entry.role ?? "user");
    const senderName = asOptionalString(entry.sender_name) ?? "Unknown";
    if (messageType === "text") {
      if (role === "assistant" && senderName === agentName) {
        continue;
      }
      lines.push(`[${senderName}]: ${content}`);
      continue;
    }

    // Room history is untrusted: tool rows carry whatever a peer published, and
    // their arguments and output are themselves tool-authored. Emitting an
    // unrecognized payload would splice it into the prompt verbatim, so only a
    // row that parses as this SDK's own tool envelope is forwarded — matching
    // every other converter, which drops what it cannot parse.
    if (messageType === "tool_call") {
      if (parseToolCall(content)) {
        lines.push(content);
      }
      continue;
    }

    if (messageType === "tool_result") {
      if (parseToolResult(content)) {
        lines.push(content);
      }
    }
  }

  return lines.join("\n");
}
