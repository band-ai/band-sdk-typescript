import type { PlatformMessage } from "../../runtime/types";
import { EventConverter } from "./eventConverter";
import { decodeACPFailure } from "./failure";
import type { BandACPServerAdapter } from "./BandACPServerAdapter";

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

    const update = EventConverter.convert(
      message,
      message.messageType === "error" ? decodeACPFailure(message) : undefined,
    )
    if (!update) {
      return
    }

    await connection.sessionUpdate({
      sessionId,
      update,
    })
  }
}
