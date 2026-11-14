import type { HistoryConverter } from "../contracts/protocols";
import { buildReplayMessages, type ReplayMessage } from "./shared";

/**
 * What one room's Claude session knows. A turn runs in its own CLI process, so
 * a process with no session to resume is seeded from the room's transcript
 * instead, and that transcript is what this state carries.
 */
export interface ClaudeCliSessionState {
  /** The room's text history as `[sender]: content` lines. */
  replayMessages: ReplayMessage[];
}

export class ClaudeCliHistoryConverter implements HistoryConverter<ClaudeCliSessionState> {
  public convert(raw: Array<Record<string, unknown>>): ClaudeCliSessionState {
    return { replayMessages: buildReplayMessages(raw) };
  }
}
