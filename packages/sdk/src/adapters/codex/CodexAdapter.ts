import type { TurnTools } from "../../core/turn";
import type { HistoryProvider } from "../../runtime/types";
import { RoomScopedAdapter } from "../shared/roomScopedAdapter";
import { CodexRoomAgent, type CodexAdapterOptions } from "./CodexRoomAgent";

/**
 * Runs the Codex app-server, one process per room. Each room's process runs in
 * that room's own workspace, so its events, approvals and file writes stay in
 * that room.
 *
 * Band's tools are sent only when a thread starts, never on resume, so a
 * thread started before a tool existed (such as `band_no_reply`) lacks it.
 */
export class CodexAdapter extends RoomScopedAdapter<HistoryProvider, TurnTools, CodexRoomAgent> {
  protected readonly provider = "codex";
  private readonly options: CodexAdapterOptions;

  public constructor(options: CodexAdapterOptions = {}) {
    const { cwd, workspaceForRoom, ...config } = options.config ?? {};
    super({ cwd, workspaceForRoom, logger: options.logger });
    this.options = { ...options, config };
  }

  protected createRoom(roomId: string, workspace: string): CodexRoomAgent {
    return new CodexRoomAgent({ ...this.options, roomId, config: { ...this.options.config, cwd: workspace } });
  }
}
