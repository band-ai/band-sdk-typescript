import { ACPClientHistoryConverter, type ACPClientSessionState } from "../../converters/acp-client";
import type { AdapterToolsProtocol } from "../../contracts/protocols";
import { RoomScopedAdapter } from "../shared/roomScopedAdapter";
import {
  ACPRoomAgent,
  validateACPClientOptions,
  type ACPClientAdapterOptions,
  type ACPRoomAgentOptions,
} from "./ACPRoomAgent";

/**
 * Runs an external ACP agent, one subprocess per room. Each room's process
 * runs in that room's own workspace and has its own Band MCP backend, so rooms
 * share no filesystem, failure or credentials.
 */
export class ACPClientAdapter extends RoomScopedAdapter<ACPClientSessionState, AdapterToolsProtocol, ACPRoomAgent> {
  protected readonly provider: string = "acp"
  protected readonly roomOptions: Omit<ACPRoomAgentOptions, "cwd" | "roomId" | "provider">

  public constructor(options: ACPClientAdapterOptions) {
    const { cwd, workspaceForRoom, ...roomOptions } = options
    super({ historyConverter: new ACPClientHistoryConverter(), cwd, workspaceForRoom, logger: options.logger })
    this.roomOptions = { ...roomOptions, command: validateACPClientOptions(options) }
  }

  protected createRoom(roomId: string, workspace: string): ACPRoomAgent {
    return new ACPRoomAgent({ ...this.roomOptions, roomId, cwd: workspace, provider: this.provider })
  }
}
