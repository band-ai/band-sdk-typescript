import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "../../core/logger";
import { Serializer } from "../../core/singleFlight";

import { JournalFileError, JournalPublicationError } from "./errors";
import {
  JOURNAL_FORMAT_VERSION,
  identityDirectoryComponent,
  journalHeaderSchema,
  journalRecordSchema,
  roomFileComponent,
  type JournalHeader,
  type JournalRecord,
  type PublicationOutcome,
  type PublicationState,
} from "./records";

export type { PublicationOutcome };

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

export interface UnresolvedPublication {
  messageId: string;
  publicationId: string;
  /** `pending`: nothing says whether Band has it; `unknown`: whether it has it is uncertain. */
  outcome: "pending" | "unknown";
  at: number;
}

interface InboundIndex {
  answered: boolean;
  publications: Map<string, PublicationState>;
  at: number;
}

const NOOP_LOGGER: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function toLine(record: Record<string, unknown>): string {
  return `${JSON.stringify(record)}\n`;
}

/** The durable header line a v2 journal opens with, bound to its identity, agent and room. */
export function headerLine(identity: string, agentId: string, roomId: string, at: number): string {
  return toLine({ t: "header", v: JOURNAL_FORMAT_VERSION, platformIdentity: identity, agentId, roomId, at });
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
      for (const entry of keptTail !== null ? [...records, keptTail] : records) {
        applyChecked(index, entry.record, file);
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
    if (found.length === 0) return found;
    this.logger.warn(
      "Recovering unpublished replies the journal cannot confirm; Band may already hold them",
      { roomId: this.options.roomId, publications: found.length },
    );
    for (const publication of found) {
      // Stands announced across the room's handles before the record is owed, so a
      // handle that reopens the file later does not announce it again.
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
    return this.writes.run(async () => {
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
    });
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

function applyChecked(index: Map<string, InboundIndex>, record: JournalRecord, file: string): void {
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
    }
  } finally {
    inbound.at = Math.max(inbound.at, record.at);
    index.set(record.messageId, inbound);
  }
}