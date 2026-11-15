import { OmpRpcHistoryConverter, type OmpRpcSessionState } from "../../converters/omp-rpc";
import { ValidationError } from "../../core/errors";
import type { TurnTools } from "../../core/turn";
import type { McpToolRegistration } from "../../mcp/registrations";
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
  /** Asked once per room, where the room is made, for the tools that must answer to that room. */
  private readonly additionalToolsForRoom?: (roomId: string) => McpToolRegistration[];

  public constructor(options: OmpRpcAdapterOptions = {}) {
    const { cwd, workspaceForRoom, additionalToolsForRoom, ...roomOptions } = options;
    super({ historyConverter: new OmpRpcHistoryConverter(), cwd, workspaceForRoom, logger: options.logger });
    this.additionalToolsForRoom = additionalToolsForRoom;
    this.roomOptions = { ...roomOptions, command: validateOmpRpcOptions(options) };
  }

  /** Cancels the room's running turn; see {@link OmpRoomAgent.cancelTurn}. */
  public async cancelTurn(roomId: string): Promise<boolean> {
    return (await this.roomEngine(roomId)?.cancelTurn(roomId)) ?? false;
  }

  protected createRoom(roomId: string, workspace: string): OmpRoomAgent {
    const additionalTools = this.roomToolsFor(roomId);
    // Forwarded per call, so an engine sees whichever sink is attached when it reports.
    return new OmpRoomAgent({ ...this.roomOptions, additionalTools, roomId, cwd: workspace, observer: (event) => this.observer(event) });
  }

  /**
   * The room's host tools: the shared set, then what this room asked for. A name carried by both would
   * be settled by whichever registration the agent's map happened to keep, so the collision is refused
   * where the room is made — the same rule that rejects duplicate names within one set, applied across
   * the two. Without the per-room option, the shared set is handed on exactly as before.
   */
  private roomToolsFor(roomId: string): McpToolRegistration[] {
    const shared = this.roomOptions.additionalTools ?? [];
    const perRoom = this.additionalToolsForRoom?.(roomId) ?? [];
    const names = new Set<string>();
    for (const tool of [...shared, ...perRoom]) {
      if (names.has(tool.name)) {
        throw new ValidationError(`OMP host tools must have unique names: ${tool.name}`);
      }
      names.add(tool.name);
    }
    return [...shared, ...perRoom];
  }
}
