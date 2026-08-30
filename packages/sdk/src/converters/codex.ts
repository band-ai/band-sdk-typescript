import type { HistoryConverter } from "../contracts/protocols";
import { findLatestTaskMetadata } from "../adapters/shared/history";
import { asNonEmptyString } from "../adapters/shared/coercion";
import { parseDate } from "./shared";

export interface CodexSessionState {
  threadId: string | null;
  roomId: string | null;
  createdAt: Date | null;
}

export class CodexHistoryConverter implements HistoryConverter<CodexSessionState> {
  public setAgentName(_name: string): void {}

  public convert(raw: Array<Record<string, unknown>>): CodexSessionState {
    const metadata = findLatestTaskMetadata(
      raw,
      (entry) => typeof entry.codex_thread_id === "string" && entry.codex_thread_id.length > 0,
    );

    if (!metadata) {
      return {
        threadId: null,
        roomId: null,
        createdAt: null,
      };
    }

    return {
      threadId: asNonEmptyString(metadata.codex_thread_id),
      roomId: asNonEmptyString(metadata.codex_room_id),
      createdAt: parseDate(metadata.codex_created_at),
    };
  }
}

export function extractCodexSessionId(raw: Array<Record<string, unknown>>): string | null {
  const metadata = findLatestTaskMetadata(
    raw,
    (entry) => typeof entry.codex_thread_id === "string" && entry.codex_thread_id.length > 0,
  );
  const sessionId = metadata?.codex_thread_id;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
}
