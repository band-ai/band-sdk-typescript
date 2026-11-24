import type { ToolOperationResult } from "../../contracts/dtos";
import { NO_REPLY_RESULT } from "../../contracts/toolSchemas";
import { DeliveryUnknownError, isDeliveryUnknownOutput } from "../../core/deliveryFailedError";
import { assertNever, errorClassOf } from "../../core/errors";
import type { Logger } from "../../core/logger";
import { classifyFailedAttempt } from "../../client/rest/messageDelivery";
import { cutShort } from "../turnRevocation";
import { closedJournalError, JournalPublicationError, poisonedJournalError } from "./errors";
import type { OperationCheck, RoomJournal } from "./RoomJournal";
import { GenerationClosedError, type JournalGeneration } from "./TurnJournal";
import {
  committedNothing,
  isFailedOperationResult,
  isStorableResult,
  operationFingerprint,
  publicRefusalText,
  UNKNOWN_OPERATION_MESSAGES,
  storedSendResult,
  validateOperationId,
  OperationConflictError,
  OperationRefusedError,
  OperationUnsupportedError,
} from "./operations";
import type { OperationKind } from "./records";

/** What a newly reserved keyed send needs before its post: its resolved recipients and its single-attempt post. */
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
   * Runs a keyed operation through the journal: a known id is checked before
   * any roster lookup or transport — a matching call joins the in-flight
   * promise or replays the stored outcome, a different fingerprint is a
   * conflict refused before any post, and an id the file left admitted with
   * no outcome stands unknown on every retry. A new id is reserved durably
   * before its transport runs: `send` resolves the first send's recipients,
   * stores them, posts once, and settles the stored public result before it
   * stands; `decline` runs the harness's decision and settles only when it
   * stands. A send that provably committed nothing (cut short before its
   * post, a 408/429, Band's stopped-room answer) is released, not refused:
   * this call fails, and a later same-id call runs again. The caller's own
   * inbound settles when the outcome stands for it; a refusal, release, or
   * unknown settles nothing, and the writer that lost a write it owed stops
   * admitting.
   */
  public async publishOperation(input: OperationInput): Promise<ToolOperationResult> {
    const operationId = validateOperationId(input.operationId);
    return await this.runTracked(input.messageId, (journal) => this.runOperation(journal, input, operationId));
  }

  private async runOperation(journal: RoomJournal, input: OperationInput, operationId: string): Promise<ToolOperationResult> {
    const fingerprint = operationFingerprint({
      kind: input.kind,
      content: input.content,
      reason: input.reason,
      mentions: input.mentions,
    });
    // Joiners hear this call's outcome, refusal included, through it.
    const deferred = Promise.withResolvers<ToolOperationResult>();
    // Only a joining call awaits it; this call hears its own outcome directly.
    deferred.promise.catch(() => undefined);
    const inflight = { promise: deferred.promise };
    const check = await journal.checkAndReserveOperation({
      operationId,
      fingerprint,
      kind: input.kind,
      messageId: input.messageId,
      inflight,
    });

    const status = check.status;
    try {
      switch (status) {
        case "conflict":
          throw new OperationConflictError(operationId);
        case "unknown":
          // The fingerprint binds the kind, so the stored operation's kind is this call's.
          throw new DeliveryUnknownError(
            new Error(`operation ${operationId} stands unknown in the journal`),
            operationId,
            UNKNOWN_OPERATION_MESSAGES[input.kind],
          );
        case "refused":
          throw new OperationRefusedError(check.reasonText ?? `the journal records operation ${operationId} as refused: Band answered and saved nothing`);
        case "settled": {
          // The stored result stands first: a send whose authority no longer
          // validates throws before the caller's inbound is settled for it,
          // so a broken replay settles nothing for anyone.
          const result = this.storedOperationResult(journal, operationId, check);
          await this.settleOperationCaller(journal, input.messageId, input.kind);
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
        default:
          return assertNever(status, "operation check");
      }
    } catch (error) {
      deferred.reject(error);
      throw error;
    } finally {
      // Only the call that reserved the operation releases its in-flight mark,
      // for an outcome no record cleared it for; a joiner's entry is the owner's.
      if (status === "reserved") {
        journal.clearOperationInflight(operationId, inflight);
      }
    }
  }

  private async runReservedOperation(
    journal: RoomJournal,
    input: OperationInput,
    operationId: string,
    deferred: PromiseWithResolvers<ToolOperationResult>,
  ): Promise<ToolOperationResult> {
    const result = input.kind === "send"
      ? await this.runKeyedSend(journal, input, operationId)
      : await this.runKeyedDecline(journal, input, operationId);
    await this.settleOperationCaller(journal, input.messageId, input.kind);
    deferred.resolve(result);
    return result;
  }

  private async runKeyedSend(journal: RoomJournal, input: OperationInput, operationId: string): Promise<ToolOperationResult> {
    if (input.prepare === undefined) {
      return await this.refuse(journal, operationId, "the once transport the operation needs stands unavailable", { error: new OperationUnsupportedError("no-once-transport") });
    }
    // No recipients stand yet: the reservation is re-admissible as it is.
    const blockedBefore = blockedPost(journal, input.stopped);
    if (blockedBefore) throw blockedBefore;
    const preparation = await input.prepare();
    await journal.storeOperationRecipients(operationId, preparation.recipients);
    const blocked = blockedPost(journal, input.stopped);
    if (blocked) return await this.release(journal, operationId, blocked);

    let result: ToolOperationResult;
    try {
      result = await preparation.post();
    } catch (error) {
      if (classifyFailedAttempt(error) === "uncertain") {
        return await this.standUnknown(journal, input.kind, operationId, error, { cause: noVerdict() });
      }
      if (committedNothing(error)) {
        return await this.release(journal, operationId, new OperationRefusedError(publicRefusalText(error)), error);
      }
      return await this.refuse(journal, operationId, publicRefusalText(error), { failure: error });
    }
    // A resolved delivery-unknown stands unknown, like the thrown one; any
    // other resolved failure is a definite refusal, stored as classified text.
    if (isDeliveryUnknownOutput(result)) {
      return await this.standUnknown(journal, input.kind, operationId, result, { cause: noVerdict() });
    }
    if (isFailedOperationResult(result)) return await this.refuse(journal, operationId, publicRefusalText(result));
    // The stored result is what every later same-id call replays: one the
    // JSON store would not keep unchanged cannot stand as settled.
    if (!isStorableResult(result)) {
      return await this.standUnknown(journal, input.kind, operationId, new Error("the post's acknowledgment does not stand as a stored result"));
    }
    await this.settleOrUnknown(journal, input.kind, operationId, { receiptId: receiptIdOf(result), resultJson: JSON.stringify(result) });
    return result;
  }

  private async runKeyedDecline(journal: RoomJournal, input: OperationInput, operationId: string): Promise<ToolOperationResult> {
    const harnessRefusal = "the harness could not run this no-reply";
    if (input.runDecline === undefined) {
      return await this.refuse(journal, operationId, harnessRefusal, { error: new OperationUnsupportedError("no-journal") });
    }
    let result: ToolOperationResult;
    try {
      result = await input.runDecline();
    } catch (error) {
      // The harness's raw error never reaches a caller or the journal; only its class is logged.
      return await this.refuse(journal, operationId, harnessRefusal, { failure: error });
    }
    if (isFailedOperationResult(result)) return await this.refuse(journal, operationId, publicRefusalText(result));
    if (!isStorableResult(result)) {
      return await this.standUnknown(journal, input.kind, operationId, new Error("the decline's decision does not stand as a stored result"));
    }
    await this.settleOrUnknown(journal, input.kind, operationId, {});
    return result;
  }

  /** Settles the operation; a settlement that cannot be recorded leaves it unknown and poisons the writer that owed it. */
  private async settleOrUnknown(
    journal: RoomJournal,
    kind: OperationKind,
    operationId: string,
    settlement: { receiptId?: string; resultJson?: string },
  ): Promise<void> {
    try {
      await journal.settleOperation(operationId, settlement);
    } catch (error) {
      await this.standUnknown(journal, kind, operationId, error, { poisonWriter: true });
    }
  }

  /**
   * Records the operation unknown and throws its `DeliveryUnknownError`, whose
   * cause is `cause` (a classified stand-in where the raw error must not travel).
   */
  private async standUnknown(
    journal: RoomJournal,
    kind: OperationKind,
    operationId: string,
    error: unknown,
    { poisonWriter = false, cause = error }: { poisonWriter?: boolean; cause?: unknown } = {},
  ): Promise<never> {
    let recorded = true;
    try {
      await journal.markOperationUnknown(operationId);
    } catch (recordError) {
      recorded = false;
      this.logger.error("the operation stands unknown, and its record failed to land; the room's journal no longer admits records", {
        roomId: journal.roomId,
        operationId,
        ...errorClassOf(error),
        recordError,
      });
    }
    // A writer that lost a write it owed stops admitting.
    if (poisonWriter || !recorded) journal.poison();
    if (recorded) {
      this.logger.warn("operation delivery is unknown; the journal records it as unknown and reports it instead of reposting it", {
        roomId: journal.roomId,
        operationId,
        ...errorClassOf(error),
      });
    }
    throw new DeliveryUnknownError(cause, operationId, UNKNOWN_OPERATION_MESSAGES[kind]);
  }

  /**
   * Records a definite refusal and throws `error`, by default the classified
   * text's `OperationRefusedError`. When the record fails, its error is what the
   * caller sees, as for a reply's refusal. The refusal is logged by its
   * classified text and the class of the `failure` behind it, never the raw
   * failure, which can carry a body.
   */
  private async refuse(
    journal: RoomJournal,
    operationId: string,
    reasonText: string,
    { error = new OperationRefusedError(reasonText), failure }: { error?: Error; failure?: unknown } = {},
  ): Promise<never> {
    try {
      await journal.refuseOperation(operationId, reasonText);
    } catch (recordError) {
      this.logger.error("the operation was refused, and its refusal record failed to land", {
        roomId: journal.roomId,
        operationId,
        error,
        recordError,
      });
      throw recordError;
    }
    this.logger.warn("a keyed operation was refused; the journal records the refusal, and a same-id call replays it", {
      roomId: journal.roomId,
      operationId,
      reason: reasonText,
      ...errorClassOf(failure),
    });
    throw error;
  }

  /**
   * Releases a keyed send that provably committed nothing and throws `error`:
   * this call fails, and a later same-id call is admitted again. Its record
   * lands as a refusal's does, and its failure is what the caller sees.
   */
  private async release(journal: RoomJournal, operationId: string, error: Error, failure?: unknown): Promise<never> {
    try {
      await journal.releaseOperation(operationId);
    } catch (recordError) {
      this.logger.error("the operation committed nothing, and its release record failed to land", {
        roomId: journal.roomId,
        operationId,
        error,
        recordError,
      });
      throw recordError;
    }
    this.logger.warn("a keyed send committed nothing; the journal releases it, and a same-id call is admitted again", {
      roomId: journal.roomId,
      operationId,
      ...errorClassOf(failure ?? error),
    });
    throw error;
  }

  /**
   * The caller's inbound settles when the operation's outcome stands: a send
   * or a no-reply answered it. The outcome is already durable, so a failed
   * settlement record leaves it standing: the caller hears the outcome, and
   * the writer that lost the write stops admitting.
   */
  private async settleOperationCaller(journal: RoomJournal, messageId: string, kind: OperationKind): Promise<void> {
    try {
      if (kind === "decline") {
        await journal.settleDecline(messageId);
      } else {
        await journal.turnDone(messageId);
      }
    } catch (error) {
      journal.poison();
      this.logger.error("the operation's outcome stands, and its caller's settlement record failed to land; the room's journal no longer admits records", {
        roomId: journal.roomId,
        messageId,
        error,
      });
    }
  }

  /**
   * The stored result of a settled operation, as it stands for a later same-id
   * caller. A settled decline stands as the decline itself; a settled send's
   * authority is its stored result. One that does not stand has no replay:
   * inventing success would be a publication the journal never recorded, so
   * the journal poisons instead of answering.
   */
  private storedOperationResult(journal: RoomJournal, operationId: string, check: Extract<OperationCheck, { status: "settled" }>): ToolOperationResult {
    if (journal.operation(operationId)?.kind === "decline") {
      return NO_REPLY_RESULT;
    }
    const stored = storedSendResult(check.resultJson);
    if (stored === undefined) {
      journal.poison();
      throw new JournalPublicationError(
        `The journal records the settled operation ${operationId} without a stored result that stands: the replay is refused rather than invented, and the journal no longer admits records until it is restored.`,
        "poisoned",
      );
    }
    return stored;
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

/** Why a keyed send's post must not run: its turn was cut short, or its journal stopped admitting. */
function blockedPost(journal: RoomJournal, stopped: AbortSignal | undefined): Error | undefined {
  const cut = stopped && cutShort(stopped);
  if (cut) return cut;
  return journal.accepting ? undefined : poisonedJournalError();
}

/** The stand-in cause of an attempt that ended without a verdict: the transport's raw error never travels. */
function noVerdict(): Error {
  return new Error("the once port's attempt ended without a verdict");
}

/** The post id Band attributed: the top-level `id` FernRestAdapter's createChatMessage returns. */
export function receiptIdOf(result: ToolOperationResult): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  return "id" in result && typeof result.id === "string" && result.id.length > 0 ? result.id : undefined;
}
