import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "../../core/logger";
import { Serializer } from "../../core/singleFlight";

import { JournalFileError, JournalPublicationError } from "./errors";
import {
  identityDirectoryComponent,
  journalHeaderSchema,
  journalRecordSchema,
  roomFileComponent,
  type JournalHeader,
  type JournalRecord,
  type OperationKind,
  type PublicationState,
} from "./records";

/** A journal read or write failure; the file is in its cause. */
export function journalFileFailure(error: unknown): JournalFileError {
  if (error instanceof JournalFileError) return error;
  return new JournalFileError("Turn journal I/O failed", "io", "", error);
}

/** Whether `error` is a file system error with `code`. */
export function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * Flushes `dir`'s entries, so a file created or renamed in it survives an OS
 * crash, not only a process one. Windows cannot open a directory for this.
 */
export async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const COMPACTING_COPY = /^\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.compacting$/;

/** Removes the copies of `file` a crash left mid-rewrite; they never replaced it. */
export async function removeOrphanedCopies(file: string): Promise<void> {
  const dir = path.dirname(file);
  const base = path.basename(file);
  for (const name of await readdir(dir)) {
    if (name.startsWith(base) && COMPACTING_COPY.test(name.slice(base.length))) {
      await rm(path.join(dir, name), { force: true });
    }
  }
}

/** Replaces `file` with `text`, through a renamed copy so a crash leaves the old file or the new one. */
export async function rewriteFile(file: string, text: string): Promise<void> {
  const copy = `${file}.${randomUUID()}.compacting`;
  try {
    const handle = await open(copy, "w");
    try {
      await handle.writeFile(text, "utf8");
      await handle.datasync();
    } finally {
      await handle.close();
    }
    await rename(copy, file);
  } catch (error) {
    await rm(copy, { force: true });
    throw error;
  }
  await syncDirectory(path.dirname(file));
}

export interface RoomJournalOptions {
  /** What the file's directory and header must both say the journal is bound to. */
  platformIdentity: string;
  /** What the agent's directory and header must both say the journal belongs to. */
  agentId: string;
  /** The room whose handling the file records; names the file, not the header. */
  roomId: string;
  /** The clock records are stamped by; `Date.now` by default. */
  now?: () => number;
  logger?: Logger;
  /** Whether the generation already announced the publication, on any of the room's handles. */
  hasAnnounced?: (publicationId: string) => boolean;
  /** Registers the publication as announced by the generation, so no later handle announces it again. */
  markAnnounced?: (publicationId: string) => void;
}

/** How one admitted reply stands in the journal. */
export type PublicationOutcome = "pending" | "settled" | "refused" | "unknown";

export interface UnresolvedPublication {
  messageId: string;
  publicationId: string;
  /** The keyed operation whose delivery stands unresolved, when the authority is an operation, not a reply. */
  operationId?: string;
  /** `pending`: nothing says whether Band has it; `unknown`: whether it has it is uncertain. */
  outcome: "pending" | "unknown";
  at: number;
}

interface PublicationIndex {
  outcome: PublicationOutcome;
  receiptId?: string;
  reported: boolean;
  at: number;
}

interface InboundIndex {
  answered: boolean;
  publications: Map<string, PublicationIndex>;
  at: number;
}

/** How one keyed operation stands in the journal, by its id. */
export interface OperationIndex {
  /** The first caller's inbound: the turn the operation was admitted in. */
  messageId: string;
  kind: OperationKind;
  fingerprint: string;
  /** The first send's resolved recipient identities, when they stood. */
  recipients?: string[];
  outcome: "pending" | "settled" | "refused" | "unknown";
  receiptId?: string;
  /** The settled send's stored public result, as JSON. */
  resultJson?: string;
  /** The stored refusal's public text, when the file kept one. */
  reasonText?: string;
  reported: boolean;
  at: number;
}

/**
 * What `checkAndReserveOperation` found: a new id to reserve and run, an
 * in-flight call to join, a stored outcome to replay or re-throw, or a
 * conflict that refuses the call before any post.
 */
export type OperationCheck =
  | { status: "reserved" }
  | { status: "inflight"; promise: Promise<unknown> }
  | { status: "settled"; receiptId?: string; resultJson?: string }
  | { status: "refused"; reasonText?: string }
  | { status: "unknown" }
  | { status: "conflict" };

const NOOP_LOGGER: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function toLine(record: Record<string, unknown>): string {
  return `${JSON.stringify(record)}\n`;
}

function headerLine(identity: string, agentId: string, roomId: string, at: number): string {
  return toLine({ t: "header", v: 2, platformIdentity: identity, agentId, roomId, at });
}

/**
 * One room's v2 journal: its identity-bound file of what Band acknowledged,
 * what it refused, and what is unknown, plus which inbounds settled.
 *
 * Every record that says a reply landed or an inbound settled is durable on
 * disk before the call that wrote it resolves, and none of it ever expires:
 * the journal is the authority that a restarted runtime does not answer a
 * settled message again or re-post a reply Band already has. A file it cannot
 * validate strictly is refused — the room stays closed — never reset to empty.
 */
export class RoomJournal {
  private inbounds = new Map<string, InboundIndex>();
  /** The keyed operations this file records, by operation id. */
  private operations = new Map<string, OperationIndex>();
  /** The operations whose delivery stands unresolved — admitted in the file with no recorded outcome. */
  private unresolvedOps = new Map<string, { messageId: string; at: number }>();
  /** The operations this handle admitted: an in-flight call later calls join the same promise. */
  private inflightOps = new Map<string, { promise: Promise<unknown> }>();
  /** The operations this handle already announced as unresolved. */
  private announcedOps = new Set<string>();
  /**
   * The publications whose delivery stands unresolved — admitted in the file
   * with no recorded outcome (a process died mid-post) or recorded as unknown.
   * Publications this handle admits itself are tracked by the generation, not
   * here: they are in flight, not a delivery mystery.
   */
  private unresolved = new Map<string, { messageId: string; at: number }>();
  /** The in-flight or last-finished recovery, so callers queue behind one another. */
  private recovery: Promise<UnresolvedPublication[]> = Promise.resolve([]);
  private readonly writes = new Serializer();
  private readonly now: () => number;
  private readonly logger: Logger;
  /** A failed append may have left part of a line; the next one starts a line of its own. */
  private lineCut = false;
  private closed = false;
  /**
   * Set once an outcome the journal could not record followed a result it
   * already owed (an acknowledged reply whose settlement write failed): new
   * publications are refused until the handle closes and the room's journal
   * reopens, rather than carried on half-recorded.
   */
  private poisoned = false;

  private constructor(
    private readonly handle: FileHandle,
    private readonly options: RoomJournalOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  /**
   * Opens the room's file, validating it strictly: its header must bind the
   * journal to `platformIdentity` and `agentId` and sit under the directory
   * its identity hashes to, and every whole record must parse and keep the
   * journal's state coherent. A torn final line is kept when it is itself a
   * whole valid record; otherwise the valid prefix is kept and the torn tail
   * dropped, so a crash mid-append never erases an earlier unresolved intent.
   */
  public static async open(file: string, options: RoomJournalOptions): Promise<RoomJournal> {
    const now = options.now ?? Date.now;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await removeOrphanedCopies(file);
      const expectedComponent = identityDirectoryComponent(options.platformIdentity);
      if (path.basename(path.dirname(file)) !== expectedComponent) {
        throw new JournalFileError(
          `The journal directory for ${options.platformIdentity} is not where its identity hashes it: ${path.dirname(file)}`,
          "corrupt",
          file,
        );
      }
      if (path.basename(file) !== `${roomFileComponent(options.roomId)}.jsonl`) {
        throw new JournalFileError(
          `The room's journal must live at the file its room id hashes to; this file is not that file, so its records are not this room's`,
          "corrupt",
          file,
        );
      }
      const text = await readFile(file, "utf8").catch((error: unknown) => {
        if (hasErrorCode(error, "ENOENT")) return null;
        throw error;
      });
      if (text === null) {
        // A new file: its header is durable before its directory entry is not.
        await rewriteFile(file, headerLine(options.platformIdentity, options.agentId, options.roomId, now()));
        const handle = await open(file, "a");
        try {
          await syncDirectory(path.dirname(file));
        } catch (error) {
          await handle.close();
          throw error;
        }
        return new RoomJournal(handle, options);
      }

      const lines = text.split("\n");
      // A crash may have cut the final line short of its newline.
      const tornTail = text.endsWith("\n") ? null : (lines.pop() ?? null);
      const wholeLines = text.endsWith("\n") ? lines.slice(0, -1) : lines;

      const header = parseHeader(file, wholeLines[0], options);
      const records: Array<{ line: string; record: JournalRecord }> = [];
      for (const line of wholeLines.slice(1)) {
        if (line === "") continue;
        const record = parseRecord(file, line);
        records.push({ line, record });
      }

      let keptTail: { line: string; record: JournalRecord } | null = null;
      if (tornTail !== null) {
        try {
          const record = parseRecord(file, tornTail);
          // The tail is a whole record a crash left without its newline; keep it, newline and all.
          keptTail = { line: tornTail, record };
        } catch (error) {
          if (!(error instanceof JournalFileError)) throw error;
          // A torn tail that is not a whole record: the valid prefix stands.
        }
      }

      const index = new Map<string, InboundIndex>();
      const ops = new Map<string, OperationIndex>();
      for (const entry of keptTail !== null ? [...records, keptTail] : records) {
        applyChecked(index, ops, entry.record, file);
      }

      if (tornTail !== null) {
        // The tail was dropped, or kept without its newline: rewrite the file
        // whole, records byte-for-byte, so the next append starts a line.
        const kept = keptTail !== null ? [...records, keptTail] : records;
        await rewriteFile(
          file,
          headerLine(header.platformIdentity, header.agentId, header.roomId, header.at) + kept.map(({ line }) => `${line}\n`).join(""),
        );
      }

      const handle = await open(file, "a");
      const journal = new RoomJournal(handle, options);
      journal.inbounds = index;
      journal.operations = ops;
      // A leftover pending operation whose recipients the file recorded may
      // already be in the room: it stands unknown. A leftover pending one with
      // no recipients recorded stands provably unposted — the post ran only
      // after that record — and is re-admissible, not announced. An operation
      // the file recorded unknown stands the same way: it may be in the room,
      // and a handle that never heard it announced must report it.
      for (const [operationId, operation] of ops) {
        if (operation.outcome === "unknown" || (operation.outcome === "pending" && operation.recipients !== undefined)) {
          journal.unresolvedOps.set(operationId, { messageId: operation.messageId, at: operation.at });
        }
      }
      // Every publication the file left without an outcome is unresolved: this
      // handle admitted none of them, so each is the leftover of an earlier
      // process's post that may already be in the room.
      for (const [messageId, inbound] of index) {
        for (const [publicationId, publication] of inbound.publications) {
          if (publication.outcome === "pending" || publication.outcome === "unknown") {
            journal.unresolved.set(publicationId, { messageId, at: publication.at });
          }
        }
      }
      return journal;
    } catch (error) {
      throw journalFileFailure(error);
    }
  }

  /** Whether this handle closed: its room's handling stopped, and the room's next turn opens a new one. */
  public get isClosed(): boolean {
    return this.closed;
  }

  /** The room this file records. */
  public get roomId(): string {
    return this.options.roomId;
  }

  /** Whether the room's publications are admitted at all. */
  public get accepting(): boolean {
    return !this.closed && !this.poisoned;
  }

  /** Whether a turn ended, or a reply or decline settled, for `messageId`. */
  public answered(messageId: string): boolean {
    return this.inbounds.get(messageId)?.answered ?? false;
  }

  /**
   * The publication the file records under `publicationId`, whichever outcome
   * it stands in; `undefined` when the file admits no such publication. A
   * read-only view for the offline checks that stand on the file's recorded
   * authority (the migration's validation of what it imported).
   */
  public publication(publicationId: string): { messageId: string; outcome: PublicationOutcome } | undefined {
    for (const [messageId, inbound] of this.inbounds) {
      const record = inbound.publications.get(publicationId);
      if (record !== undefined) return { messageId, outcome: record.outcome };
    }
    return undefined;
  }

  /**
   * The room's publications whose delivery stands unresolved — the file left
   * one admitted with no recorded outcome, or recorded it as unknown — that
   * this handle has not announced yet. Announces each, recording the
   * announcement best-effort so this handle does not announce it again; a
   * record it cannot write is logged, and the announcement stands in memory.
   * Publications this handle admitted itself are in flight, not unresolved,
   * and never announced here.
   */
  public recoverUnresolved(): Promise<UnresolvedPublication[]> {
    // Serialized per handle: an announcement in flight marks what it reports
    // before a second caller may see the same publications again.
    this.recovery = this.recovery.catch(() => undefined).then(() => this.runRecovery());
    return this.recovery;
  }

  private async runRecovery(): Promise<UnresolvedPublication[]> {
    if (this.closed) return [];
    const found: UnresolvedPublication[] = [];
    for (const [publicationId, info] of this.unresolved) {
      const publication = this.inbounds.get(info.messageId)?.publications.get(publicationId);
      // A publication this generation already announced on another handle of the
      // room stands announced: this handle reopens the same file after one of its
      // earlier handles closed, and the operator hears each recovery once.
      if (publication === undefined || publication.reported || (this.options.hasAnnounced?.(publicationId) ?? false)) continue;
      found.push({ messageId: info.messageId, publicationId, outcome: publication.outcome === "pending" ? "pending" : "unknown", at: publication.at });
    }
    // A keyed operation the file left admitted with no outcome stands unknown the
    // same way; its announcement stands in the file, so a handle that reopens
    // it does not announce it again.
    for (const info of this.unresolvedOperations()) {
      found.push({ messageId: info.messageId, publicationId: "", operationId: info.operationId, outcome: "unknown", at: info.at });
    }
    if (found.length === 0) return found;
    this.logger.warn(
      "Recovering unpublished replies the journal cannot confirm; Band may already hold them",
      { roomId: this.options.roomId, publications: found.length },
    );
    for (const publication of found) {
      // Stands announced across the room's handles before the record is owed, so a
      // handle that reopens the file later does not announce it again.
      if (publication.operationId !== undefined) {
        await this.announceOperation(publication.operationId);
        continue;
      }
      this.options.markAnnounced?.(publication.publicationId);
      await this.appendBestEffort({ t: "publication.reported", messageId: publication.messageId, publicationId: publication.publicationId, at: this.now() });
      const record = this.inbounds.get(publication.messageId)?.publications.get(publication.publicationId);
      if (record) record.reported = true;
    }
    return found;
  }

  /** Records that a reply is about to begin posting; the post does not run until this is durable. */
  public async beginReply(messageId: string): Promise<string> {
    this.assertAdmitting();
    const publicationId = randomUUID();
    await this.append({ t: "reply.intent", messageId, publicationId, at: this.now() });
    const inbound = this.touch(messageId);
    inbound.publications.set(publicationId, { outcome: "pending", reported: false, at: this.now() });
    return publicationId;
  }

  /** Records that Band acknowledged the reply; the reply is settled and the inbound answered. */
  public async settleReply(messageId: string, publicationId: string, receiptId?: string): Promise<void> {
    this.assertAdmitting();
    const at = this.now();
    await this.append({ t: "reply.settled", messageId, publicationId, ...(receiptId !== undefined ? { receiptId } : {}), at });
    const inbound = this.touch(messageId);
    inbound.answered = true;
    const publication = inbound.publications.get(publicationId);
    if (publication) {
      publication.outcome = "settled";
      publication.at = at;
      if (receiptId !== undefined) publication.receiptId = receiptId;
    }
    this.unresolved.delete(publicationId);
  }

  /** Records that Band answered and saved nothing: the reply is definitely not in the room. */
  public async markRefused(messageId: string, publicationId: string): Promise<void> {
    this.assertAdmitting();
    const at = this.now();
    await this.append({ t: "reply.refused", messageId, publicationId, at });
    const publication = this.touch(messageId).publications.get(publicationId);
    if (publication) {
      publication.outcome = "refused";
      publication.at = at;
    }
    this.unresolved.delete(publicationId);
  }

  /** Records that whether Band has the reply is unknown: it may already be in the room. */
  public async markUnknown(messageId: string, publicationId: string): Promise<void> {
    this.assertAdmitting();
    const at = this.now();
    await this.append({ t: "reply.unknown", messageId, publicationId, at });
    const publication = this.touch(messageId).publications.get(publicationId);
    if (publication) {
      publication.outcome = "unknown";
      publication.reported = true;
      publication.at = at;
    }
    this.unresolved.set(publicationId, { messageId, at });
  }

  /** Records that the inbound's no-reply was accepted: it is answered and answered again never. */
  public async settleDecline(messageId: string): Promise<void> {
    this.assertAdmitting();
    await this.append({ t: "decline.settled", messageId, at: this.now() });
    this.touch(messageId).answered = true;
  }

  /** Records that the inbound's turn ended, before it is marked processed. */
  public async turnDone(messageId: string): Promise<void> {
    this.assertAdmitting();
    await this.append({ t: "turn.done", messageId, at: this.now() });
    this.touch(messageId).answered = true;
  }

  /**
   * The keyed operation the file records under `operationId, whichever outcome
   * it stands in; `undefined` when the file admits no such operation. A
   * read-only view for the checks that stand on the file's recorded authority.
   */
  public operation(operationId: string): OperationIndex | undefined {
    return this.operations.get(operationId);
  }

  /**
   * Atomically checks `operationId` against the file and, when the file holds
   * it for no operation, reserves it: the reservation record is durable before
   * the method returns, and the lock is released before any network I/O the
   * caller then runs. A call this handle is already running for the id joins
   * that call's promise; a call the file already decided replays or refuses
   * its stored outcome; a known id bound to a different fingerprint is a
   * conflict, refused before any post.
   */
  public async checkAndReserveOperation(input: {
    operationId: string;
    fingerprint: string;
    kind: OperationKind;
    messageId: string;
    inflight?: { promise: Promise<unknown> };
  }): Promise<OperationCheck> {
    return this.writes.run(() => this.checkAndReserveLocked(input));
  }

  private async checkAndReserveLocked(input: {
    operationId: string;
    fingerprint: string;
    kind: OperationKind;
    messageId: string;
    inflight?: { promise: Promise<unknown> };
  }): Promise<OperationCheck> {
    this.assertAdmitting();
    const existing = this.operations.get(input.operationId);
    if (existing !== undefined) {
      if (existing.fingerprint !== input.fingerprint) {
        return { status: "conflict" };
      }
      const inflight = this.inflightOps.get(input.operationId);
      if (inflight !== undefined) {
        return { status: "inflight", promise: inflight.promise };
      }
      if (existing.outcome === "pending") {
        if (existing.recipients === undefined) {
          // The file proves the post never ran: the recipients' record, written
          // before the post, stands unrecorded, and nothing after it can exist.
          // The operation is re-admitted to run again.
          if (input.inflight !== undefined) {
            this.inflightOps.set(input.operationId, input.inflight);
          }
          return { status: "reserved" };
        }
        // The post ran, or may have: its outcome the file records is none, and
        // it stands unknown on every same-id retry.
        return { status: "unknown" };
      }
      if (existing.outcome === "unknown") {
        return { status: "unknown" };
      }
      if (existing.outcome === "settled") {
        return { status: "settled", receiptId: existing.receiptId, resultJson: existing.resultJson };
      }
      return { status: "refused", reasonText: existing.reasonText };
    }

    const at = this.now();
    await this.appendLocked({ t: "op.reserved", operationId: input.operationId, fingerprint: input.fingerprint, kind: input.kind, messageId: input.messageId, at });
    this.operations.set(input.operationId, {
      messageId: input.messageId,
      kind: input.kind,
      fingerprint: input.fingerprint,
      outcome: "pending",
      reported: false,
      at,
    });
    if (input.inflight !== undefined) {
      this.inflightOps.set(input.operationId, input.inflight);
    }
    return { status: "reserved" };
  }

  /**
   * Records the first send's resolved recipient identities, durably, before
   * the post runs: a retry of the operation stands for the recipients the
   * roster resolved when it was admitted, not for whoever the roster names
   * later.
   */
  public async storeOperationRecipients(operationId: string, recipients: string[]): Promise<void> {
    this.assertAdmitting();
    const operation = this.operations.get(operationId);
    if (operation === undefined) {
      this.poison();
      throw new JournalPublicationError("The journal holds no such keyed operation; its recipients cannot be recorded", "poisoned");
    }
    if (operation.recipients !== undefined) {
      this.poison();
      throw new JournalPublicationError("The journal already records this operation's recipients; a second record is a conflict", "poisoned");
    }
    const at = this.now();
    await this.append({ t: "op.recipients", operationId, recipients, messageId: operation.messageId, at });
    operation.recipients = recipients;
  }

  /** Records that Band acknowledged the keyed send; the stored result stands for every later same-id call. */
  public async settleOperation(operationId: string, settlement: { receiptId?: string; resultJson?: string }): Promise<void> {
    this.assertAdmitting();
    const operation = this.requireOperation(operationId);
    const at = this.now();
    await this.append({
      t: "op.settled",
      operationId,
      messageId: operation.messageId,
      ...(settlement.receiptId !== undefined ? { receiptId: settlement.receiptId } : {}),
      ...(settlement.resultJson !== undefined ? { resultJson: settlement.resultJson } : {}),
      at,
    });
    operation.outcome = "settled";
    operation.at = at;
    if (settlement.receiptId !== undefined) operation.receiptId = settlement.receiptId;
    if (settlement.resultJson !== undefined) operation.resultJson = settlement.resultJson;
    // A durable keyed settlement is the operation's original inbound
    // answered: a reopen must report it answered without waiting for a
    // turn.done or decline record, and never redeliver the message.
    this.touch(operation.messageId).answered = true;
    this.inflightOps.delete(operationId);
    this.unresolvedOps.delete(operationId);
  }

  /** Records that the keyed operation definitely did not stand. */
  public async refuseOperation(operationId: string, reasonText?: string): Promise<void> {
    this.assertAdmitting();
    const operation = this.requireOperation(operationId);
    const at = this.now();
    await this.append({ t: "op.refused", operationId, messageId: operation.messageId, ...(reasonText !== undefined ? { reasonText } : {}), at });
    operation.outcome = "refused";
    operation.at = at;
    if (reasonText !== undefined) operation.reasonText = reasonText;
    this.inflightOps.delete(operationId);
    this.unresolvedOps.delete(operationId);
  }

  /** Records that whether Band has the keyed send is unknown: it may already be in the room. */
  public async markOperationUnknown(operationId: string): Promise<void> {
    this.assertAdmitting();
    const operation = this.requireOperation(operationId);
    const at = this.now();
    await this.append({ t: "op.unknown", operationId, messageId: operation.messageId, at });
    operation.outcome = "unknown";
    operation.reported = true;
    operation.at = at;
    this.inflightOps.delete(operationId);
    this.unresolvedOps.set(operationId, { messageId: operation.messageId, at });
  }

  /** Releases the in-flight mark once the operation's call has run to its outcome. */
  public clearOperationInflight(operationId: string): void {
    this.inflightOps.delete(operationId);
  }

  /** The room's operations whose delivery stands unresolved, that this handle has not announced yet. */
  public unresolvedOperations(): { operationId: string; messageId: string; at: number }[] {
    const found: { operationId: string; messageId: string; at: number }[] = [];
    for (const [operationId, info] of this.unresolvedOps) {
      const operation = this.operations.get(operationId);
      if (operation === undefined || operation.reported || this.announcedOps.has(operationId)) continue;
      found.push({ operationId, messageId: info.messageId, at: info.at });
    }
    return found;
  }

  /** Announces one unresolved operation, recording the announcement best-effort. */
  public async announceOperation(operationId: string): Promise<void> {
    this.announcedOps.add(operationId);
    const operation = this.operations.get(operationId);
    if (operation === undefined) return;
    await this.appendBestEffort({ t: "op.reported", operationId, messageId: operation.messageId, at: this.now() });
    operation.reported = true;
  }

  private requireOperation(operationId: string): OperationIndex {
    const operation = this.operations.get(operationId);
    if (operation === undefined) {
      this.poison();
      throw new JournalPublicationError("The journal holds no such keyed operation; its outcome cannot be recorded", "poisoned");
    }
    return operation;
  }

  /**
   * The journal owed an outcome it could not record (an acknowledged reply
   * whose settlement write failed): from here on it refuses new publications
   * until its handle closes and the room's journal reopens.
   */
  public poison(): void {
    this.poisoned = true;
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Queued after every write already accepted.
    await this.writes.run(() => this.handle.close());
  }

  private assertAdmitting(): void {
    if (this.closed) {
      throw new JournalPublicationError("The room's journal is closed; its handling stopped", "closed");
    }
    if (this.poisoned) {
      throw new JournalPublicationError(
        "The room's journal cannot record a publication outcome it owes, so it refuses new replies; restart the runtime so the journal reopens and reports what is unresolved",
        "poisoned",
      );
    }
  }

  private append(record: Record<string, unknown>): Promise<void> {
    return this.writes.run(() => this.appendLocked(record));
  }

  /**
   * An append for a caller already holding the write serializer: the compound
   * operations that check state and record its outcome in one write go through
   * this, so the queue is never re-entered and a check that records in the
   * same write cannot deadlock on itself.
   */
  private async appendLocked(record: Record<string, unknown>): Promise<void> {
    const line = `${this.lineCut ? "\n" : ""}${toLine(record)}`;
    try {
      this.lineCut = true;
      await this.handle.appendFile(line, "utf8");
      await this.handle.datasync();
      this.lineCut = false;
    } catch (error) {
      // The write or its sync failed: the file may hold a torn record, and the
      // writer that lost the write it owes stops admitting. No later append may
      // stand beneath an uncertain write; the writer is fresh again on reopen.
      this.poisoned = true;
      throw journalFileFailure(error);
    }
  }

  /** Like `append`, for records whose failure the caller reports rather than throws. */
  private async appendBestEffort(record: Record<string, unknown>): Promise<void> {
    try {
      await this.append(record);
    } catch (error) {
      this.logger.warn("Failed to record a journal record", { roomId: this.options.roomId, t: record.t, error });
    }
  }

  /** `messageId`'s index, moved to the newest end. */
  private touch(messageId: string): InboundIndex {
    const index = this.inbounds.get(messageId) ?? { answered: false, publications: new Map(), at: this.now() };
    this.inbounds.delete(messageId);
    index.at = this.now();
    this.inbounds.set(messageId, index);
    return index;
  }
}

function parseHeader(file: string, line: string | undefined, options: RoomJournalOptions): JournalHeader {
  let json: unknown;
  try {
    json = JSON.parse(line ?? "");
  } catch {
    throw new JournalFileError(
      `The journal at ${file} has no readable header line; it is not a journal this version can trust. Restore it from backup or run the offline journal migration; deleting it discards the journal's authority.`,
      "corrupt",
      file,
    );
  }
  const check = journalHeaderSchema.safeParse(json);
  if (!check.success) {
    throw new JournalFileError(
      `The journal at ${file} has a header this version does not understand. Restore it from backup or run the offline journal migration; deleting it discards the journal's authority.`,
      "unsupported",
      file,
    );
  }
  if (check.data.platformIdentity !== options.platformIdentity) {
    throw new JournalFileError(
      `The journal at ${file} is bound to a different platform identity (${check.data.platformIdentity}) than the one configured (${options.platformIdentity}); a changed deployment identity is a different journal, not a migration of this one.`,
      "corrupt",
      file,
    );
  }
  if (check.data.agentId !== options.agentId) {
    throw new JournalFileError(
      `The journal at ${file} belongs to a different agent (${check.data.agentId}) than the one running (${options.agentId}).`,
      "corrupt",
      file,
    );
  }
  if (check.data.roomId !== options.roomId) {
    throw new JournalFileError(
      `The journal at ${file} records the room ${check.data.roomId}, not the room it is asked to journal (${options.roomId}); a room's records are not another room's authority, so the file is refused rather than adopted.`,
      "corrupt",
      file,
    );
  }
  return check.data;
}

/**
 * A settled send's stored result, as the file proves it: JSON that parses to
 * a plain result object. A settled authority that fails this stands refused
 * for the replay — and answers no inbound on a reopen — rather than settled
 * on a copy the file cannot prove.
 */
function isStorableResultJson(resultJson: string): boolean {
  try {
    const parsed: unknown = JSON.parse(resultJson);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function parseRecord(file: string, line: string): JournalRecord {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    throw new JournalFileError(
      `The journal at ${file} holds a line that is not a record; it may be corrupt. Restore it from backup or run the offline journal migration; deleting it discards the journal's authority.`,
      "corrupt",
      file,
    );
  }
  const check = journalRecordSchema.safeParse(json);
  if (!check.success) {
    throw new JournalFileError(
      `The journal at ${file} holds a record this version does not understand. It may be corrupt, or it was written by another version or tool. Restore it from backup or run the offline journal migration; deleting it discards the journal's authority.`,
      "unsupported",
      file,
    );
  }
  return check.data;
}

function applyChecked(index: Map<string, InboundIndex>, operations: Map<string, OperationIndex>, record: JournalRecord, file: string): void {
  const inbound = index.get(record.messageId) ?? { answered: false, publications: new Map<string, PublicationState>(), at: record.at };
  try {
    switch (record.t) {
      case "reply.intent": {
        if (inbound.publications.has(record.publicationId)) {
          throw new JournalFileError(`The journal at ${file} holds a publication's intent twice; its state is in conflict.`, "corrupt", file);
        }
        inbound.publications.set(record.publicationId, { outcome: "pending", reported: false, at: record.at });
        break;
      }
      case "reply.settled":
      case "reply.refused":
      case "reply.unknown": {
        const publication = inbound.publications.get(record.publicationId);
        if (publication === undefined) {
          throw new JournalFileError(`The journal at ${file} records an outcome for ${record.publicationId} without its intent; its state is in conflict.`, "corrupt", file);
        }
        if (publication.outcome !== "pending") {
          throw new JournalFileError(`The journal at ${file} records ${record.t} twice for ${record.publicationId}; its state is in conflict.`, "corrupt", file);
        }
        publication.outcome = record.t === "reply.settled" ? "settled" : record.t === "reply.refused" ? "refused" : "unknown";
        publication.at = record.at;
        if (record.t === "reply.settled" && record.receiptId !== undefined) {
          publication.receiptId = record.receiptId;
        }
        if (record.t === "reply.settled") inbound.answered = true;
        break;
      }
      case "decline.settled":
      case "turn.done":
        inbound.answered = true;
        break;
      case "publication.reported": {
        const publication = inbound.publications.get(record.publicationId);
        if (publication === undefined) {
          throw new JournalFileError(`The journal at ${file} records a report for ${record.publicationId} without its intent; its state is in conflict.`, "corrupt", file);
        }
        publication.reported = true;
        break;
      }
      case "op.reserved": {
        const operation = operations.get(record.operationId);
        if (operation !== undefined) {
          throw new JournalFileError(
            `The journal at ${file} reserves operation ${record.operationId} twice${operation.fingerprint === record.fingerprint ? "" : " with a different fingerprint"}; its state is in conflict.`,
            "corrupt",
            file,
          );
        }
        operations.set(record.operationId, {
          messageId: record.messageId,
          kind: record.kind,
          fingerprint: record.fingerprint,
          outcome: "pending",
          reported: false,
          at: record.at,
        });
        break;
      }
      case "op.recipients": {
        const operation = operations.get(record.operationId);
        if (operation === undefined) {
          throw new JournalFileError(`The journal at ${file} records recipients for operation ${record.operationId} without its reservation; its state is in conflict.`, "corrupt", file);
        }
        if (operation.recipients !== undefined) {
          throw new JournalFileError(`The journal at ${file} records recipients for operation ${record.operationId} twice; its state is in conflict.`, "corrupt", file);
        }
        if (operation.outcome !== "pending") {
          throw new JournalFileError(`The journal at ${file} records recipients for a finished operation ${record.operationId}; its state is in conflict.`, "corrupt", file);
        }
        operation.recipients = record.recipients;
        operation.at = record.at;
        break;
      }
      case "op.settled":
      case "op.refused":
      case "op.unknown": {
        const operation = operations.get(record.operationId);
        if (operation === undefined) {
          throw new JournalFileError(`The journal at ${file} records an outcome for operation ${record.operationId} without its reservation; its state is in conflict.`, "corrupt", file);
        }
        if (operation.outcome !== "pending") {
          throw new JournalFileError(`The journal at ${file} records ${record.t} twice for operation ${record.operationId}; its state is in conflict.`, "corrupt", file);
        }
        operation.outcome = record.t === "op.settled" ? "settled" : record.t === "op.refused" ? "refused" : "unknown";
        operation.at = record.at;
        if (record.t === "op.settled") {
          if (record.receiptId !== undefined) operation.receiptId = record.receiptId;
          if (record.resultJson !== undefined) operation.resultJson = record.resultJson;
          // A settled operation answers its original inbound when it stood —
          // except where its stored authority no longer stands: a send whose
          // file records no result that validates settles a replay on
          // nothing, and a reopen must not credit the caller a success the
          // journal cannot prove. A settled decline stands on the record
          // itself, which this replay has already taken.
          if (operation.kind === "decline" || (record.resultJson !== undefined && isStorableResultJson(record.resultJson))) {
            inbound.answered = true;
          }
        }
        if (record.t === "op.refused" && record.reasonText !== undefined) {
          operation.reasonText = record.reasonText;
        }
        break;
      }
      case "op.reported": {
        const operation = operations.get(record.operationId);
        if (operation === undefined) {
          throw new JournalFileError(`The journal at ${file} records a report for operation ${record.operationId} without its reservation; its state is in conflict.`, "corrupt", file);
        }
        operation.reported = true;
        break;
      }
    }
  } finally {
    inbound.at = Math.max(inbound.at, record.at);
    index.set(record.messageId, inbound);
  }
}