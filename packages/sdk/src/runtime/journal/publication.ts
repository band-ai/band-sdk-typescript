import type { ToolOperationResult } from "../../contracts/dtos";
import { DeliveryUnknownError } from "../../core/deliveryFailedError";
import type { Logger } from "../../core/logger";
import { classifyFailedAttempt } from "../../client/rest/messageDelivery";
import { RoomJournal } from "./RoomJournal";
import { TurnCutShortError } from "./journalTools";
import type { JournalGeneration } from "./TurnJournal";

/**
 * The engine that turns a reply post or an accepted decline into the room's
 * durable publication: the intent is recorded before the transport is
 * invoked, and the settlement (accepted, refused, or unknown) is recorded
 * before the post's outcome is returned to the caller. A journal file that
 * will not admit new records refuses the post (fail-closed): the reply is
 * not delivered rather than being delivered unrecorded.
 *
 * When the room has no journal (the journal is disabled, or its open failed
 * and the runtime kept serving), the post runs unrecorded — the v1 behavior,
 * whose only cost is that the reply can be answered again after a restart.
 */
export class PublicationEngine {
  private constructor(
    private readonly room: () => Promise<RoomJournal | undefined>,
    private readonly generation: JournalGeneration | undefined,
    private readonly logger: Logger,
  ) {}

  public static create(options: {
    room: () => Promise<RoomJournal | undefined>;
    generation?: JournalGeneration;
    logger: Logger;
  }): PublicationEngine {
    return new PublicationEngine(options.room, options.generation, options.logger);
  }

  /** The journal for the room this engine serves, or none when serving unjournalled. */
  private async journal(): Promise<RoomJournal | undefined> {
    const room = await this.room();
    return room?.accepting ? room : undefined;
  }

  /**
   * Posts a reply through the journal: the durable intent is written before
   * `post` runs (a failed write never lets the post out), and the accepted
   * post is settled before its result is returned.
   *
   * - `uncertain` delivery (a 5xx, no response, or an unreadable response):
   *   the publication is marked unknown, the room's journal is poisoned so no
   *   further admission can be recorded, and a `DeliveryUnknownError` is
   *   thrown — it states that Band may already hold the message and that
   *   resending it blindly is unsafe.
   * - `refused`/`notCommitted`: the publication is marked refused (the
   *   record is best-effort where the file will not take it) and the
   *   original failure propagates, so the turn fails and may be retried.
   */
  public async publishReply(
    messageId: string,
    post: () => Promise<ToolOperationResult>,
    stopped?: AbortSignal,
  ): Promise<ToolOperationResult> {
    if (stopped?.aborted) throw new TurnCutShortError();
    const journal = await this.journal();
    if (!journal) return post();

    const publicationId = await journal.beginReply(messageId);
    // A turn cut short between the durable intent and the post: the reply is
    // refused, not delivered — the platform never saw it.
    if (stopped?.aborted) {
      await journal.markRefused(messageId, publicationId).catch((error: unknown) => {
        this.logger.warn("the interrupted reply's refusal could not be recorded", { roomId: journal.roomId, error });
      });
      throw new TurnCutShortError();
    }
    const tracked = (async (): Promise<ToolOperationResult> => {
      try {
        const result = await post();
        await journal.settleReply(messageId, publicationId, receiptIdOf(result));
        return result;
} catch (error) {
        if (classifyFailedAttempt(error) === "uncertain") {
          let recorded = false;
          try {
            await journal.markUnknown(messageId, publicationId);
            recorded = true;
          } catch (recordError) {
            this.logger.error("delivery unknown, and its journal record failed; the room's journal no longer admits records", {
              roomId: journal.roomId,
              error,
              recordError,
            });
          }
          if (!recorded) {
            // The record failed but the room kept admitting; make it stop.
            journal.poison();
          }
          this.logger.warn("reply delivery is unknown; the publication is recorded as unknown and the room will not admit further replies until the journal reopens", {
            roomId: journal.roomId,
            error,
          });
          throw new DeliveryUnknownError(error, publicationId);
        }
        await journal.markRefused(messageId, publicationId).catch((error: unknown) => {
          this.logger.warn("the refused reply's record could not be written", { roomId: journal.roomId, error });
        });
        throw error;
      }
    })();
    this.generation?.trackInflight(tracked, journal.roomId);
    return tracked;
  }

  /**
   * Runs a decline (no transport: the harness decides not to reply) and, only
   * when it stands, records its durable settlement before returning — so a
   * settled decline can never be redelivered, and a decline the harness
   * refuses records no settlement.
   */
  public async publishDecline<T>(messageId: string, run: () => Promise<T>): Promise<T> {
    const journal = await this.journal();
    if (!journal) return run();

    const tracked = (async (): Promise<T> => {
      const result = await run();
      await journal.settleDecline(messageId);
      return result;
    })();
    this.generation?.trackInflight(tracked, journal.roomId);
    return tracked;
  }

  /** The journal this engine serves, when it admits records; `undefined` while poisoned or closed. */
  public async roomJournal(): Promise<RoomJournal | undefined> {
    return await this.journal();
  }
}

function receiptIdOf(result: ToolOperationResult): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  if (!("message" in result)) return undefined;
  const message = result.message;
  if (typeof message !== "object" || message === null) return undefined;
  if (!("id" in message)) return undefined;
  const id = message.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}