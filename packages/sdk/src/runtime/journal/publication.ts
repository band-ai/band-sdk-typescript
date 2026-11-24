import type { ToolOperationResult } from "../../contracts/dtos";
import { DeliveryUnknownError } from "../../core/deliveryFailedError";
import type { Logger } from "../../core/logger";
import { classifyFailedAttempt } from "../../client/rest/messageDelivery";
import { cutShort } from "../turnRevocation";
import { closedJournalError, poisonedJournalError } from "./errors";
import type { RoomJournal } from "./RoomJournal";
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
  private readonly roomId: string;
  private readonly generation: JournalGeneration;
  private readonly logger: Logger;

  public constructor(options: { roomId: string; generation: JournalGeneration; logger: Logger }) {
    this.roomId = options.roomId;
    this.generation = options.generation;
    this.logger = options.logger;
  }

  /**
   * The room's publication authority. Fail-closed: a journal that will not
   * open, a closed generation, or a handle that no longer admits records
   * refuses the publication rather than deliver it unjournaled.
   */
  private async authority(held: Promise<RoomJournal>): Promise<RoomJournal> {
    let room: RoomJournal;
    try {
      room = await held;
    } catch (error) {
      // A closed generation is no authority at all, and it is not the journal
      // being disabled: the runtime stopped the room's handling, and the
      // publication is refused rather than delivered unjournaled.
      if (error instanceof GenerationClosedError) throw closedJournalError();
      throw error;
    }
    if (!room.accepting) throw poisonedJournalError();
    return room;
  }

  /**
   * Posts a reply through the journal. The intent is durable before `post`
   * runs; the result returns only once the outcome is durable. A reply cut
   * short (by `stopped`) or that Band refused is recorded refused and its
   * error rethrown. An uncertain delivery, or an acknowledgment whose record
   * failed, stands unknown and throws `DeliveryUnknownError`: Band may hold
   * it, so it is never resent blindly; a writer that lost a write it owed is
   * poisoned until it reopens.
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
    return this.runTracked(messageId, async (journal) => {
      const publicationId = await journal.beginReply(messageId);
      // A turn cut short between the durable intent and the post: the reply is
      // refused, not delivered — the platform never saw it. Refusal must land
      // or fail closed visibly; never swallow a markRefused rejection and leave
      // a never-posted intent as recoverable pending on reopen.
      if (stopped) {
        const cut = cutShort(stopped);
        if (cut) return await this.settleAsRefused(journal, messageId, publicationId, cut);
      }
      let result: ToolOperationResult;
      try {
        result = await post();
      } catch (error) {
        if (classifyFailedAttempt(error) === "uncertain") {
          return await this.settleAsUnknown(journal, messageId, publicationId, error, { poisonWriter: false });
        }
        return await this.settleAsRefused(journal, messageId, publicationId, error);
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
  }

  /**
   * Records that the publication was refused, and throws the refusal. When
   * the record fails, its error is what the caller sees; the refusal it
   * replaces is logged with it so it is not lost.
   */
  private async settleAsRefused(journal: RoomJournal, messageId: string, publicationId: string, refusal: unknown): Promise<never> {
    try {
      await journal.markRefused(messageId, publicationId);
    } catch (recordError) {
      this.logger.error("the reply was refused, and its refusal record failed to land", {
        roomId: journal.roomId,
        publicationId,
        error: refusal,
        recordError,
      });
      throw recordError;
    }
    throw refusal;
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
    if (recorded) {
      this.logger.warn("reply delivery is unknown; the publication is recorded as unknown and the room reports it instead of reposting it", {
        roomId: journal.roomId,
        error,
      });
    }
    throw new DeliveryUnknownError(error, publicationId);
  }

  /**
   * Runs a decline (no transport: the harness decides not to reply) and, only
   * when it stands, records its durable settlement before returning — so a
   * settled decline can never be redelivered, and a decline the harness
   * refuses records no settlement.
   */
  public async publishDecline<T>(messageId: string, run: () => Promise<T>): Promise<T> {
    return this.runTracked(messageId, async (journal) => {
      const result = await run();
      await journal.settleDecline(messageId);
      return result;
    });
  }

  /**
   * Runs `work` on the room's journal under a tracked hold, taken before any
   * await: the handle never closes under the publication, and a stop waits
   * for its outcome. The hold ends before the caller sees the outcome.
   */
  private runTracked<T>(messageId: string, work: (journal: RoomJournal) => Promise<T>): Promise<T> {
    const hold = this.generation.trackRoom(this.roomId, messageId);
    const run = (async () => await work(await this.authority(hold.journal)))();
    const end = (): void => hold.end();
    void run.then(end, end);
    return run;
  }
}

/** The post id Band attributed: the top-level `id` FernRestAdapter's createChatMessage returns. */
function receiptIdOf(result: ToolOperationResult): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  return "id" in result && typeof result.id === "string" && result.id.length > 0 ? result.id : undefined;
}
