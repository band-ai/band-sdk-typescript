import { OmpRpcHistoryConverter, type OmpRpcSessionState } from "../../converters/omp-rpc";
import type { TurnTools } from "../../core/turn";
import { RoomScopedAdapter } from "../shared/roomScopedAdapter";
import {
  OmpRoomAgent,
  validateOmpRpcOptions,
  type OmpRoomAgentOptions,
  type OmpRpcAdapterOptions,
} from "./OmpRoomAgent";

/**
 * Runs OMP in its native RPC mode (`omp --mode rpc`), one process per room.
 * Each room's process runs in that room's own workspace and calls the Band
 * tools as host tools bound to that room, so rooms share no filesystem,
 * failure or tools. One process could serve several rooms by switching
 * sessions; this adapter keeps one per room so a room's start, stop and
 * failure are its own, as with the ACP adapters.
 */
export class OmpRpcAdapter extends RoomScopedAdapter<OmpRpcSessionState, TurnTools, OmpRoomAgent> {
  protected readonly provider = "omp-rpc";
  private readonly roomOptions: Omit<OmpRoomAgentOptions, "cwd" | "roomId">;

  public constructor(options: OmpRpcAdapterOptions = {}) {
    const { cwd, workspaceForRoom, ...roomOptions } = options;
    super({ historyConverter: new OmpRpcHistoryConverter(), cwd, workspaceForRoom, logger: options.logger });
    this.roomOptions = { ...roomOptions, command: validateOmpRpcOptions(options) };
  }

  /** Cancels the room's running turn; see {@link OmpRoomAgent.cancelTurn}. */
  public async cancelTurn(roomId: string): Promise<boolean> {
    return (await this.roomEngine(roomId)?.cancelTurn(roomId)) ?? false;
  }

  protected createRoom(roomId: string, workspace: string): OmpRoomAgent {
    // Forwarded per call, so an engine sees whichever sink is attached when it reports.
    return new OmpRoomAgent({ ...this.roomOptions, roomId, cwd: workspace, observer: (event) => this.observer(event) });
  }
}
