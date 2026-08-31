import { findLatestTaskMetadata } from "../adapters/shared/history";
import { asNonEmptyString } from "../core/coercion";
import { parseDate } from "./shared";

export interface OpencodeSessionState {
  sessionId: string | null;
  roomId: string | null;
  createdAt: Date | null;
  replayMessages: string[];
}

export class OpencodeHistoryConverter {
  public setAgentName(_name: string): void {}

  public convert(raw: Array<Record<string, unknown>>): OpencodeSessionState {
    const replayMessages = buildReplayMessages(raw);
    const metadata = findLatestTaskMetadata(
      raw,
      (entry) => typeof entry.opencode_session_id === "string" && entry.opencode_session_id.length > 0,
    );

    if (!metadata) {
      return {
        sessionId: null,
        roomId: null,
        createdAt: null,
        replayMessages,
      };
    }

    return {
      sessionId: asNonEmptyString(metadata.opencode_session_id),
      roomId: asNonEmptyString(metadata.opencode_room_id),
      createdAt: parseDate(metadata.opencode_created_at),
      replayMessages,
    };
  }
}

export function extractOpencodeSessionId(
  raw: Array<Record<string, unknown>>,
): string | null {
  return asNonEmptyString(
    findLatestTaskMetadata(
      raw,
      (entry) => typeof entry.opencode_session_id === "string" && entry.opencode_session_id.length > 0,
    )?.opencode_session_id,
  );
}

function buildReplayMessages(raw: Array<Record<string, unknown>>): string[] {
  const replayMessages: string[] = [];

  for (const entry of raw) {
    if (String(entry.message_type ?? "text") !== "text") {
      continue;
    }

    const content = asNonEmptyString(entry.content);
    if (!content) {
      continue;
    }

    const senderName = asNonEmptyString(entry.sender_name)
      ?? asNonEmptyString(entry.sender_type)
      ?? "Unknown";
    replayMessages.push(`[${senderName}]: ${content}`);
  }

  return replayMessages;
}
