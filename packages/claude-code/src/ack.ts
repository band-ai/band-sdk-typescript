import { isToolExecutorError, type AdapterToolsProtocol, type Logger } from "@band-ai/sdk/core";

export interface AckLink {
  markProcessing(roomId: string, messageId: string): Promise<void>;
  markProcessed(roomId: string, messageId: string): Promise<void>;
}

/**
 * Band's message status is `sent -> processing -> processed`. Marking
 * "processing" happens on push (whether or not Claude Code has channels
 * enabled to render it); marking "processed" happens only once Claude
 * actually replies in that room, via `markRepliedIn`. A message that never
 * gets a reply stays `processing`, and the runtime hands it back on every
 * start; the handler keeps it out of a transcript that already received it
 * and re-tracks it here with `trackPending`, so a later reply still acks it.
 */
export class AckTracker {
  private readonly pendingByRoom = new Map<string, Set<string>>();

  public constructor(
    private readonly link: AckLink,
    private readonly logger: Logger,
  ) {}

  /** A message passed gating and is about to be (or was) pushed: mark processing, track it as pending. */
  public async markPushed(roomId: string, messageId: string): Promise<void> {
    try {
      await this.link.markProcessing(roomId, messageId);
    } catch (error) {
      this.logger.error("markProcessing failed", {
        room_id: roomId,
        message_id: messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.trackPending(roomId, messageId);
  }

  /** An already-`processing` message awaits a reply in `roomId`; no REST call. */
  public trackPending(roomId: string, messageId: string): void {
    this.pendingFor(roomId).add(messageId);
  }

  /** A message was dropped by gating: mark processed immediately, no pending tracking. */
  public async markGatedOut(roomId: string, messageId: string): Promise<void> {
    try {
      await this.link.markProcessed(roomId, messageId);
    } catch (error) {
      this.logger.error("markProcessed (gated-out) failed", {
        room_id: roomId,
        message_id: messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Claude successfully sent a message/event into `roomId`: mark every id pending for that room processed. */
  public async markRepliedIn(roomId: string): Promise<void> {
    const pending = this.pendingByRoom.get(roomId);
    if (!pending || pending.size === 0) return;

    const messageIds = [...pending];
    this.pendingByRoom.delete(roomId);

    for (const messageId of messageIds) {
      try {
        await this.link.markProcessed(roomId, messageId);
      } catch (error) {
        this.logger.error("markProcessed (reply) failed", {
          room_id: roomId,
          message_id: messageId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Test/introspection helper: how many message ids are currently pending for `roomId`. */
  public pendingCount(roomId: string): number {
    return this.pendingByRoom.get(roomId)?.size ?? 0;
  }

  private pendingFor(roomId: string): Set<string> {
    let set = this.pendingByRoom.get(roomId);
    if (!set) {
      set = new Set();
      this.pendingByRoom.set(roomId, set);
    }
    return set;
  }
}

const REPLY_TOOL_NAMES = new Set(["band_send_message", "band_send_event"]);

/**
 * Wrap a room's tools so a successful band_send_message/band_send_event call
 * clears every message id currently pending an ack in that room. "Successful"
 * means executeToolCall neither threw nor returned a ToolExecutorError shape
 * (a validation failure, e.g. an unresolved mention, returns the latter
 * without throwing) — see AckTracker.markRepliedIn.
 */
export function wrapToolsForAck(
  tools: AdapterToolsProtocol,
  roomId: string,
  ackTracker: AckTracker,
): AdapterToolsProtocol {
  return {
    ...tools,
    executeToolCall: async (toolName, toolArgs) => {
      const result = await tools.executeToolCall(toolName, toolArgs);
      if (REPLY_TOOL_NAMES.has(toolName) && !isToolExecutorError(result)) {
        await ackTracker.markRepliedIn(roomId);
      }
      return result;
    },
  };
}
