import type { PlatformMessage } from "../../runtime/types";
import { EventConverter } from "./eventConverter";
import type { BandACPServerAdapter } from "./BandACPServerAdapter";

/**
 * Pushes Band room messages out to the editor's ACP session, for rooms the ACP server
 * adapter currently has a session bound to.
 */
export class ACPPushHandler {
  private readonly adapter: BandACPServerAdapter

  public constructor(adapter: BandACPServerAdapter) {
    this.adapter = adapter
  }

  public async handlePushEvent(
    message: PlatformMessage,
    roomId: string,
  ): Promise<void> {
    const sessionId = this.adapter.getSessionForRoom(roomId)
    const connection = this.adapter.getConnection()
    if (!sessionId || !connection) {
      return
    }

    const update = EventConverter.convert(message)
    if (!update) {
      return
    }

    await connection.sessionUpdate({
      sessionId,
      update,
    })
  }
}
