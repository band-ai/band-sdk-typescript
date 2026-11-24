import { isDeepStrictEqual } from "node:util";
import type { ToolOperationResult } from "../../contracts/dtos";
import { isToolExecutorError } from "../../contracts/protocols";
import { DeliveryFailedError, DeliveryUnknownError } from "../../core/deliveryFailedError";
import { statusCodeOf } from "../../core/errors";
import type { Logger } from "../../core/logger";
import { classifyFailedAttempt } from "../../client/rest/messageDelivery";
import { cutShort } from "../turnRevocation";
import { closedJournalError, JournalPublicationError, poisonedJournalError } from "./errors";
import type { OperationCheck, RoomJournal } from "./RoomJournal";
import { GenerationClosedError, type JournalGeneration } from "./TurnJournal";
import {
  isFailedOperationResult,
  operationFingerprint,
  storedSendResult,
  validateOperationId,
  OperationConflictError,
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
   * stands. The caller's own inbound settles when the outcome stands for it;
   * a refusal or unknown settles nothing, and the writer that lost a write it
   * owed stops admitting.
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
    const check = await journal.checkAndReserveOperation({
      operationId,
      fingerprint,
      kind: input.kind,
      messageId: input.messageId,
      inflight: { promise: deferred.promise },
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
            unknownMessageFor(input.kind),
          );
        case "refused":
          throw new DeliveryFailedError(check.reasonText ?? `the journal records operation ${operationId} as refused: Band answered and saved nothing`);
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
      return await this.refuse(journal, operationId, "the once transport the operation needs stands unavailable", new OperationUnsupportedError("no-once-transport"));
    }
    await this.refuseIfCutShort(journal, operationId, input.stopped);
    const preparation = await input.prepare();
    await journal.storeOperationRecipients(operationId, preparation.recipients);
    if (!journal.accepting) throw poisonedJournalError();
    await this.refuseIfCutShort(journal, operationId, input.stopped);

    let result: ToolOperationResult;
    try {
      result = await preparation.post();
    } catch (error) {
      if (classifyFailedAttempt(error) === "uncertain") {
        return await this.standUnknown(journal, input.kind, operationId, error, { cause: noVerdict() });
      }
      return await this.refuse(journal, operationId, publicRefusalText(error));
    }
    // A resolved delivery-unknown stands unknown, like the thrown one; any
    // other resolved failure is a definite refusal, stored as classified text.
    if (isToolExecutorError(result) && result.details?.kind === DeliveryUnknownError.KIND) {
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
      return await this.refuse(journal, operationId, harnessRefusal, new OperationUnsupportedError("no-journal"));
    }
    let result: ToolOperationResult;
    try {
      result = await input.runDecline();
    } catch {
      // The harness's raw error never reaches a caller or the journal.
      return await this.refuse(journal, operationId, harnessRefusal);
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
        error,
        recordError,
      });
    }
    // A writer that lost a write it owed stops admitting.
    if (poisonWriter || !recorded) journal.poison();
    if (recorded) {
      this.logger.warn("operation delivery is unknown; the journal records it as unknown and reports it instead of reposting it", {
        roomId: journal.roomId,
        error,
      });
    }
    throw new DeliveryUnknownError(cause, operationId, unknownMessageFor(kind));
  }

  /**
   * Records a definite refusal and throws `error`, by default the classified
   * text's `DeliveryFailedError`. When the record fails, its error is what the
   * caller sees, as for a reply's refusal.
   */
  private async refuse(
    journal: RoomJournal,
    operationId: string,
    reasonText: string,
    error: Error = new DeliveryFailedError(reasonText),
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
    throw error;
  }

  /** A turn cut short before the post: the operation is refused, never posted. */
  private async refuseIfCutShort(journal: RoomJournal, operationId: string, stopped: AbortSignal | undefined): Promise<void> {
    const cut = stopped && cutShort(stopped);
    if (cut) await this.refuse(journal, operationId, "the turn was cut short before the post", cut);
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
      return { status: "ok" };
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

/** The stand-in cause of an attempt that ended without a verdict: the transport's raw error never travels. */
function noVerdict(): Error {
  return new Error("the once port's attempt ended without a verdict");
}

/** The text a keyed operation of `kind` stands unknown under: a send may already be in the room, a decline posts nothing. */
export function unknownMessageFor(kind: OperationKind): string {
  return kind === "decline" ? unknownDeclineMessage() : unknownOperationMessage();
}

/** The text a keyed operation's unknown delivery stands under: the operator reads it in the tool result. */
export function unknownOperationMessage(): string {
  return "The operation's delivery is unknown: Band may already hold it, so it must not be resent. The turn journal records the operation as unknown; a process that reopens the room reports it without reposting it.";
}

/** The text a keyed decline's unknown outcome stands under: it posts nothing, so nothing is held. */
export function unknownDeclineMessage(): string {
  return "The no-reply's outcome is unknown: its decision did not stand as a stored result, so the journal proves nothing either. The turn journal records the operation as unknown; the reply is not credited as declined, and the operation is never re-run as a success.";
}

/**
 * The classified public text a definite refusal stands under: it is what the
 * journal stores as the refusal's reason and what every later caller, joiner,
 * and replay reads. It names the refusal's class and, for an HTTP refusal,
 * its status — and nothing else. A transport's raw message, body, headers,
 * and credentials never stand in the record: a classifier that echoed them
 * would persist what the operator must not keep.
 */
function publicRefusalText(value: unknown): string {
  // A resolved executor error may carry the failure it stands for: classify from it.
  const carried: unknown = isToolExecutorError(value) && value.details?.error !== undefined ? value.details.error : value;
  const code = statusCodeOf(carried);
  if (code !== undefined) {
    return `the platform refused the post (HTTP ${code})`;
  }
  if (carried instanceof Error) {
    // The transport's failure class, not its message: a message can carry a body.
    return `the post was refused by the transport: ${carried.name}`;
  }
  if (isToolExecutorError(value)) {
    return `the post was refused by the transport (${value.errorType})`;
  }
  return "the post was refused before it reached Band";
}

/** The post id Band attributed: the top-level `id` FernRestAdapter's createChatMessage returns. */
function receiptIdOf(result: ToolOperationResult): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  return "id" in result && typeof result.id === "string" && result.id.length > 0 ? result.id : undefined;
}

/**
 * A resolved post result that stands as a settled operation's stored result:
 * a plain object the journal's JSON store keeps unchanged on the round trip.
 * Anything else — a non-object, a value the store coerces (a NaN, an
 * undefined property, a value a string would not carry back) — would settle
 * the operation on a copy different from the original result, and no such
 * copy may stand for the replay.
 */
function isStorableResult(result: unknown): boolean {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return false;
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(result);
  } catch {
    return false;
  }
  try {
    return isDeepStrictEqual(JSON.parse(encoded), result);
  } catch {
    return false;
  }
}
