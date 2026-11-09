import type { HistoryConverter } from "../contracts/protocols";
import { buildReplayMessages, type ReplayMessage } from "./shared";

export interface OmpRpcSessionState {
  /**
   * The room's text history as `[sender]: content` lines. Each OMP process
   * starts a new session, so its first prompt carries these as background.
   */
  replayMessages: ReplayMessage[];
}

export class OmpRpcHistoryConverter implements HistoryConverter<OmpRpcSessionState> {
  public convert(raw: Array<Record<string, unknown>>): OmpRpcSessionState {
    return { replayMessages: buildReplayMessages(raw) };
  }
}
