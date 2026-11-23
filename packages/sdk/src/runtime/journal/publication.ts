import type { ToolOperationResult } from "../../contracts/dtos";
import { DeliveryUnknownError } from "../../core/deliveryFailedError";
import type { Logger } from "../../core/logger";
import { classifyFailedAttempt } from "../../client/rest/messageDelivery";
import { cutShort } from "../turnRevocation";
import { JournalPublicationError } from "./errors";
import { RoomJournal } from "./RoomJournal";
import { GenerationClosedError, type JournalGeneration } from "./TurnJournal";

/**
 * The engine that turns a reply post or an accepted decline into the room's
 * durable publication: the intent is recorded before the transport is
 * invoked, and the settlement (accepted, refused, or unknown) is recorded
 * before the post's outcome is returned to the caller.
 *
 * The engine is fail-closed. It stands behind a configured generation, so a
 * reply for a room whose journal will not open, whose generation closed, or
 * whose handle no longer admits records is refused outright: nothing is
 * delivered unjournaled. Only a runtime that never configured the journal
 * posts without one, as it would anyway.
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

  /**
   * The room's publication authority. Fail-closed: a journal that will not
   * open, a closed generation, or a handle that no longer admits records
   * refuses the publication rather than deliver it unjournaled.
   */
  private async authority(): Promise<RoomJournal | undefined> {
    let room: RoomJournal | undefined;
    try {
      room = await this.room();
    } catch (error) {
      // A closed generation is no authority at all, and it is not the journal
      // being disabled: the runtime stopped the room's handling, and the
      // publication is refused rather than delivered unjournaled.
      if (error instanceof GenerationClosedError) {
        throw new JournalPublicationError(
          "The room's handling stopped before this publication could be recorded; it is refused rather than delivered unjournaled",
          "closed",
        );
      }
      throw error;
    }
    if (room !== undefined && !room.accepting) {
      throw new JournalPublicationError(
        "The room's turn journal can no longer record what this reply owes; it refuses the post rather than deliver it unrecorded. Stop the runtime, restore the journal, and start again.",
        "poisoned",
      );
    }
    return room;
  }

  /** The room's journal, or a closed refusal when no authority stands. */
  private async requireJournal(what: "reply" | "decline"): Promise<RoomJournal> {
    const journal = await this.authority();
    if (journal) return journal;
    // Configured journal with no standing authority: refuse rather than act unjournaled.
    throw new JournalPublicationError(
      `The room's turn journal no longer stands behind this ${what}; it is refused rather than ${what === "reply" ? "delivered" : "run"} unjournaled. Stop the runtime, restore the journal, and start again.`,
      "closed",
    );
  }

  /**
   * Posts a reply through the journal: the durable intent is written before
   * `post` runs (a failed write never lets the post out), and the accepted
   * post is settled before its result is returned.
   *
   * - `uncertain` delivery (a 5xx, no response, or an unreadable response):
   *   the publication is marked unknown and a `DeliveryUnknownError` is
   *   thrown — it states that Band may already hold the message, so resending
   *   it blindly is unsafe. Where the unknown's record itself fails to land,
   *   the journal is poisoned: it owed a write it could not make.
   * - the transport acknowledged but the acknowledgment's record failed:
   *   the publication stands unknown — the journal cannot prove what the
   *   transport said — and the journal is poisoned either way: a writer that
   *   lost the write it owes is not admitted again until it reopens.
   *   A `DeliveryUnknownError` is thrown, not a storage failure.
   * - `refused`/`notCommitted`: the publication is marked refused (the
   *   record is best-effort where the file will not take it) and the
   *   original failure propagates, so the turn fails and may be retried.
   */
  public async publishReply(
    messageId: string,
    post: () => Promise<ToolOperationResult>,
    stopped?: AbortSignal,
  ): Promise<ToolOperationResult> {
    if (stopped) {
      const refused = cutShort(stopped);
      if (refused) throw refused;
    }
    const journal = await this.requireJournal("reply");

    // Track before any await that can interleave with release/drain: a force
    // close or stop drain must wait on this admission, including through beginReply.
    const tracked = this.runTracked(journal.roomId, async () => {
      const publicationId = await journal.beginReply(messageId);
      // A turn cut short between the durable intent and the post: the reply is
      // refused, not delivered — the platform never saw it.
      if (stopped) {
        const cut = cutShort(stopped);
        if (cut) {
          await journal.markRefused(messageId, publicationId).catch((error: unknown) => {
            this.logger.warn("the interrupted reply's refusal could not be recorded", { roomId: journal.roomId, error });
          });
          throw cut;
        }
      }
      let result: ToolOperationResult;
      try {
        result = await post();
      } catch (error) {
        if (classifyFailedAttempt(error) === "uncertain") {
          return await this.settleAsUnknown(journal, messageId, publicationId, error, { poisonWriter: false });
        }
        await journal.markRefused(messageId, publicationId).catch((error: unknown) => {
          this.logger.warn("the refused reply's record could not be written", { roomId: journal.roomId, error });
        });
        throw error;
      }
      // The transport said yes; the yes must stand on disk before the result
      // does. The settlement's own failure is not a transport refusal — the
      // reply stands unknown, and the writer that lost the write it owes
      // stops admitting.
      try {
        await journal.settleReply(messageId, publicationId, receiptIdOf(result));
      } catch (error) {
        return await this.settleAsUnknown(journal, messageId, publicationId, error, { poisonWriter: true });
      }
      return result;
    });
    return tracked;
  }

  /**
   * Records that the publication's delivery stands unknown, and throws the
   * error that says so. When `poisonWriter`, the journal is poisoned
   * regardless of whether the record landed: it has just failed a write it
   * owed, and the next post would only start the same argument.
   */
  private async settleAsUnknown(
    journal: RoomJournal,
    messageId: string,
    publicationId: string,
    error: unknown,
    { poisonWriter }: { poisonWriter: boolean },
  ): Promise<never> {
    let recorded = true;
    try {
      await journal.markUnknown(messageId, publicationId);
    } catch (recordError) {
      recorded = false;
      this.logger.error("the publication stands unknown, and its record failed to land; the room's journal no longer admits records", {
        roomId: journal.roomId,
        error,
        recordError,
      });
    }
    if (poisonWriter || !recorded) journal.poison();
    this.logger.warn("reply delivery is unknown; the publication is recorded as unknown and the room reports it instead of reposting it", {
      roomId: journal.roomId,
      error,
    });
    throw new DeliveryUnknownError(error, publicationId);
  }

  /**
   * Runs a decline (no transport: the harness decides not to reply) and, only
   * when it stands, records its durable settlement before returning — so a
   * settled decline can never be redelivered, and a decline the harness
   * refuses records no settlement.
   */
  public async publishDecline<T>(messageId: string, run: () => Promise<T>): Promise<T> {
    const journal = await this.requireJournal("decline");
    return this.runTracked(journal.roomId, async () => {
      const result = await run();
      await journal.settleDecline(messageId);
      return result;
    });
  }

  /**
   * Runs `work` as a generation-tracked admission: the promise is registered
   * synchronously before `work` is entered, so release/drain cannot close the
   * room under an in-flight publication that has not yet called trackInflight.
   */
  private runTracked<T>(roomId: string, work: () => Promise<T>): Promise<T> {
    let finish!: (value: T | PromiseLike<T>) => void;
    let fail!: (reason?: unknown) => void;
    const tracked = new Promise<T>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    this.generation?.trackInflight(tracked, roomId);
    void work().then(finish, fail);
    return tracked;
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
