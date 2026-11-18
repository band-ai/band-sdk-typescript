import type { ToolOperationResult } from "../../contracts/dtos";
import { DeliveryUnknownError } from "../../core/deliveryFailedError";
import type { Logger } from "../../core/logger";
import { classifyFailedAttempt } from "../../client/rest/messageDelivery";
import { JournalPublicationError } from "./errors";
import { RoomJournal, type OperationCheck } from "./RoomJournal";
import { GenerationClosedError, type JournalGeneration } from "./TurnJournal";
import { TurnCutShortError } from "./journalTools";
import {
  createSettledOperation,
  operationFingerprint,
  validateOperationId,
  OperationConflictError,
  OperationUnsupportedError,
  type SettledOperation,
} from "./operations";
import type { OperationKind } from "./records";

/** The stored public result of a keyed send, as the journal keeps it. */
export interface KeyedSendPreparation {
  /** The first send's resolved recipient identities; the journal stores them before the post. */
  recipients: string[];
  /** The single-attempt post: at most one HTTP request, no retries, no read-back. */
  post: () => Promise<ToolOperationResult>;
}

/**
 * One keyed operation: a send or a no-reply carrying an operation id. The id
 * names the operation across callers and processes; the fingerprint it is
 * admitted under binds the tool kind, the exact content (or the no-reply's
 * reason), and the canonical mention inputs.
 */
export interface OperationInput {
  /** The operation id as supplied; the journal validates it before any record. */
  operationId: unknown;
  kind: OperationKind;
  content?: string;
  reason?: string;
  mentions?: readonly string[];
  /** The inbound of the caller whose turn made the call: its settlement stands on this operation's outcome. */
  messageId: string;
  /** `send` only: resolve the first send's recipients and build the once post. Runs only for a newly reserved operation, never for a known one. */
  prepare?: () => Promise<KeyedSendPreparation>;
  /** `decline` only: the harness's no-reply decision. Runs only for a newly reserved operation. */
  runDecline?: () => Promise<ToolOperationResult>;
  stopped?: AbortSignal;
}

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
 * The room's publication authority, as it stands. The engine is fail-closed:
 * it exists only behind a configured generation, so anything that breaks the
 * room's handle — a journal that will not open, a generation whose close beat
 * this reply, or a handle that no longer admits records — refuses the
 * publication rather than deliver it unjournaled.
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
    if (stopped?.aborted) throw new TurnCutShortError();
    const journal = await this.authority();
    if (!journal) {
      // The engine stands behind a configured journal: a room whose authority
      // stands behind nothing is no case of journaling being disabled, and the
      // reply is refused rather than delivered unjournaled.
      throw new JournalPublicationError(
        "The room's turn journal no longer stands behind this reply; it is refused rather than delivered unjournaled. Stop the runtime, restore the journal, and start again.",
        "closed",
      );
    }

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
    })();
    this.generation?.trackInflight(tracked, journal.roomId);
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
    const journal = await this.authority();
    if (!journal) {
      // A decline that cannot stand on the room's journal records no durable
      // settlement — a restart would redeliver the message. It is refused
      // rather than run unjournaled.
      throw new JournalPublicationError(
        "The room's turn journal no longer stands behind this decline; it is refused rather than run unjournaled. Stop the runtime, restore the journal, and start again.",
        "closed",
      );
    }

    const tracked = (async (): Promise<T> => {
      const result = await run();
      await journal.settleDecline(messageId);
      return result;
    })();
    this.generation?.trackInflight(tracked, journal.roomId);
    return tracked;
  }

  /**
   * Runs a keyed operation through the journal: a known id is checked before
   * any roster lookup or transport — a matching call joins the in-flight
   * promise or replays the stored outcome, a different fingerprint is a
   * conflict refused before any post, and an id the file left admitted with
   * no outcome stands unknown on every retry. A new id is reserved durably
   * before its transport runs: `send` resolves the first send's recipients,
   * stores them, posts once, and settles the stored public result before it
   * stands; `decline` runs the harness's decision and settles only when it
   * stands. The caller's own inbound settles when the outcome stands for it;
   * a refusal or unknown settles nothing, and the writer that lost a write it
   * owed stops admitting.
   */
  public async publishOperation(input: OperationInput): Promise<ToolOperationResult> {
    const operationId = validateOperationId(input.operationId);
    const journal = await this.authority();
    if (!journal) {
      throw new OperationUnsupportedError("no-journal");
    }

    const fingerprint = operationFingerprint({
      kind: input.kind,
      content: input.content,
      reason: input.reason,
      mentions: input.mentions,
    });
    const deferred = createSettledOperation<ToolOperationResult>();
    const check = await journal.checkAndReserveOperation({
      operationId,
      fingerprint,
      kind: input.kind,
      messageId: input.messageId,
      inflight: { promise: deferred.promise },
    });
    this.generation?.trackInflight(deferred.promise, journal.roomId);

    const status = check.status;
    try {
    switch (status) {
        case "conflict":
          throw new OperationConflictError(operationId);
        case "unknown":
          throw this.unknownOperationError(operationId);
        case "refused":
          throw this.storedRefusalError(operationId, check.reasonText);
        case "settled": {
          await this.settleOperationCaller(journal, input.messageId, input.kind);
          const result = this.storedOperationResult(journal, operationId, check);
          deferred.resolve(result);
          return result;
        }
        case "inflight": {
          // The owner's promise settles with the operation's stored public
          // result, or rejects with its refusal: the joiner hears the same
          // outcome the call it joined would have. This call's own promise
          // stands for the same outcome, so it settles with it — the
          // generation's close waits on both.
          const result = (await check.promise) as ToolOperationResult;
          await this.settleOperationCaller(journal, input.messageId, input.kind);
          deferred.resolve(result);
          return result;
        }
        case "reserved":
          return await this.runReservedOperation(journal, input, operationId, deferred);
        default: {
          // Unreachable: every outcome the journal reports is one of the cases
          // above. The guard keeps the switch honest if a new outcome lands.
          throw new Error("the journal reported an operation outcome it does not record");
        }
      }
    } catch (error) {
      deferred.reject(error);
      throw error;
    } finally {
      // Only the call that reserved the operation releases its in-flight mark:
      // a joiner's entry is the owner's, and the owner's outcomes clear it
      // through the records that settle them.
      if (status === "reserved") {
        journal.clearOperationInflight(operationId);
      }
    }
  }

  private async runReservedOperation(
    journal: RoomJournal,
    input: OperationInput,
    operationId: string,
    deferred: SettledOperation<ToolOperationResult>,
  ): Promise<ToolOperationResult> {
    if (input.kind === "send") {
      if (input.prepare === undefined) {
        await journal.refuseOperation(operationId, "the once transport the operation needs stands unavailable").catch(() => undefined);
        throw new OperationUnsupportedError("no-once-transport");
      }
      if (input.stopped?.aborted) {
        await journal.refuseOperation(operationId, "the turn was cut short before the post").catch(() => undefined);
        throw new TurnCutShortError();
      }
      const preparation = await input.prepare();
      await journal.storeOperationRecipients(operationId, preparation.recipients);
      if (!journal.accepting) {
        throw new JournalPublicationError(
          "The room's turn journal can no longer record what this operation owes; it refuses the post rather than deliver it unrecorded. Stop the runtime, restore the journal, and start again.",
          "poisoned",
        );
      }
      if (input.stopped?.aborted) {
        await journal.refuseOperation(operationId, "the turn was cut short before the post").catch(() => undefined);
        throw new TurnCutShortError();
      }

      let result: ToolOperationResult;
      try {
        result = await preparation.post();
      } catch (error) {
        if (classifyFailedAttempt(error) === "uncertain") {
          await this.settleOperationUnknown(journal, operationId, error, { poisonWriter: false });
          throw new DeliveryUnknownError(error, operationId, unknownOperationMessage());
        }
        await journal.refuseOperation(operationId, publicErrorText(error)).catch((error: unknown) => {
          this.logger.warn("the refused operation's record could not be written", { roomId: journal.roomId, error });
        });
        throw error;
      }
      try {
        await journal.settleOperation(operationId, {
          receiptId: receiptIdOf(result),
          resultJson: JSON.stringify(result),
        });
      } catch (error) {
        // The post stood but its settlement could not be recorded: the
        // operation's outcome is unknown, and the writer that lost the write
        // it owes stops admitting.
        await this.settleOperationUnknown(journal, operationId, error, { poisonWriter: true });
        throw new DeliveryUnknownError(error, operationId, unknownOperationMessage());
      }
      await this.settleOperationCaller(journal, input.messageId, input.kind);
      deferred.resolve(result);
      return result;
    }

    if (input.runDecline === undefined) {
      await journal.refuseOperation(operationId, "the harness could not run this no-reply").catch(() => undefined);
      throw new OperationUnsupportedError("no-journal");
    }
    let result: ToolOperationResult;
    try {
      result = await input.runDecline();
    } catch (error) {
      // A decline the harness refuses stands refused: no settlement, and the
      // refusal is recorded so a same-id retry re-reads it.
      await journal.refuseOperation(operationId, publicErrorText(error)).catch((error: unknown) => {
        this.logger.warn("the refused no-reply's record could not be written", { roomId: journal.roomId, error });
      });
      throw error;
    }
    try {
      await journal.settleOperation(operationId, {});
    } catch (error) {
      await this.settleOperationUnknown(journal, operationId, error, { poisonWriter: true });
      throw new DeliveryUnknownError(error, operationId, unknownOperationMessage());
    }
    await this.settleOperationCaller(journal, input.messageId, input.kind);
    deferred.resolve(result);
    return result;
  }

  /**
   * Records that the operation's outcome is unknown. Where the record itself
   * fails to land, the writer is poisoned: it owed a write it could not make.
   */
  private async settleOperationUnknown(
    journal: RoomJournal,
    operationId: string,
    error: unknown,
    { poisonWriter }: { poisonWriter: boolean },
  ): Promise<void> {
    let recorded = true;
    try {
      await journal.markOperationUnknown(operationId);
    } catch (recordError) {
      recorded = false;
      this.logger.error("the operation stands unknown, and its record failed to land; the room's journal no longer admits records", {
        roomId: journal.roomId,
        error,
        recordError,
      });
    }
    if (poisonWriter || !recorded) journal.poison();
    this.logger.warn("operation delivery is unknown; the journal records it as unknown and reports it instead of reposting it", {
      roomId: journal.roomId,
      error,
    });
  }

  /** The caller's inbound settles when the operation's outcome stands: a send or a no-reply answered it. */
  private async settleOperationCaller(journal: RoomJournal, messageId: string, kind: OperationKind): Promise<void> {
    if (kind === "decline") {
      await journal.settleDecline(messageId);
      return;
    }
    await journal.turnDone(messageId);
  }

  /** The stored result of a settled operation, as it stands for a later same-id caller. */
  private storedOperationResult(journal: RoomJournal, operationId: string, check: Extract<OperationCheck, { status: "settled" }>): ToolOperationResult {
    const operation = journal.operation(operationId);
    if (operation?.kind === "decline") {
      return { status: "ok" };
    }
    if (check.resultJson !== undefined) {
      try {
        const parsed: unknown = JSON.parse(check.resultJson);
        if (typeof parsed === "object" && parsed !== null) return parsed as ToolOperationResult;
      } catch (error) {
        this.logger.warn("the stored operation result would not parse; the receipt stands", { roomId: journal.roomId, error });
      }
    }
    if (check.receiptId !== undefined) {
      return { id: check.receiptId, success: true };
    }
    return { status: "ok" };
  }

  private unknownOperationError(operationId: string): DeliveryUnknownError {
    return new DeliveryUnknownError(
      new Error(`operation ${operationId} stands unknown in the journal`),
      operationId,
      unknownOperationMessage(),
    );
  }

  private storedRefusalError(operationId: string, reasonText: string | undefined): Error {
    const message = reasonText ?? `the journal records operation ${operationId} as refused: Band answered and saved nothing`;
    const error = new Error(message);
    error.name = "OperationRefusedError";
    return error;
  }

  /** The journal this engine stands behind, when it admits records; `undefined` when no authority stands. */
  public async roomJournal(): Promise<RoomJournal | undefined> {
    return await this.authority();
  }
}

/** The text a keyed operation's unknown delivery stands under: the operator reads it in the tool result. */
export function unknownOperationMessage(): string {
  return "The operation's delivery is unknown: Band may already hold it, so it must not be resent. The turn journal records the operation as unknown; a process that reopens the room reports it without reposting it.";
}

/** The public text a stored refusal stands under: bounded, no transport objects or credentials. */
function publicErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 512 ? `${text.slice(0, 512)}…` : text;
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