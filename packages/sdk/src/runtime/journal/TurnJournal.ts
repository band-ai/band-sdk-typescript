import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readdir, readFile, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { BandSdkError, RuntimeStateError, ValidationError } from "../../core/errors";
import type { Logger } from "../../core/logger";
import { Serializer } from "../../core/singleFlight";
import { combineTeardownErrors, isolateTeardown } from "../../core/teardown";

/** A journal line: what happened to an inbound message, and when it was written, in epoch milliseconds. */
// Loose, so fields a newer version adds to a record survive compaction.
const recordBase = z.looseObject({ messageId: z.string(), at: z.number() });
const journalRecordSchema = z.discriminatedUnion("t", [
  /** A reply to the message began posting. Nothing records how it ended: Band may or may not have it. */
  recordBase.extend({ t: z.literal("reply.intent") }),
  /** The message's turn ended; it is about to be, or was, marked processed. */
  recordBase.extend({ t: z.literal("turn.done") }),
  /** The replies begun so far for the message were reported as possibly in the room. */
  recordBase.extend({ t: z.literal("replies.reported") }),
]);

/** A record a newer version wrote: kept through compaction for that version, never applied here. */
const foreignRecordSchema = recordBase.extend({ t: z.string() }).loose();

type JournalRecord = z.infer<typeof journalRecordSchema>;
type StoredRecord = JournalRecord | z.infer<typeof foreignRecordSchema>;
/** A record before it is stamped. */
type JournalEntry = Pick<JournalRecord, "t" | "messageId">;

/** What the journal knows of one inbound message. */
export interface InboundState {
  /** Its turn ended here or in an earlier process. */
  done: boolean;
  /** Replies its unfinished turns began posting that were not reported yet. */
  unreportedReplies: number;
}

/** A message's state, stamped with when a record last touched it; the index is kept in that order. */
type InboundIndex = InboundState & { at: number };

/** The directory of one agent's journal under `journalDir`. */
export function agentJournalDir(journalDir: string, agentId: string): string {
  return path.join(journalDir, encodeURIComponent(agentId));
}

/** The path of `roomId`'s journal under an agent's journal directory. */
export function roomJournalFile(dir: string, roomId: string): string {
  return path.join(dir, `${encodeURIComponent(roomId)}.jsonl`);
}

/**
 * Runs a journal operation (a write, a close) whose failure must not stop the
 * runtime: every record only ever stops a message from being answered twice,
 * so a failure is logged and the runtime carries on as it would without a
 * journal.
 */
export async function bestEffort(operation: () => Promise<unknown>, logger: Logger, failure: string, context: Record<string, unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    logger.warn(failure, { ...context, error });
  }
}

function toLine(record: StoredRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/** A journal read or write failure; the file is in its cause. */
function journalFailure(error: unknown): BandSdkError {
  return error instanceof BandSdkError ? error : new BandSdkError("Turn journal I/O failed", error);
}

export interface TurnJournalOptions {
  /**
   * How long a message is remembered after its last record. Past that it is
   * forgotten, and answered again if Band still serves it. Expired messages
   * are dropped from a room's file when it opens.
   */
  retentionMs: number;
  /** The clock records are stamped and expired by; `Date.now` by default. */
  now?: () => number;
  logger?: Logger;
}

/**
 * One agent's turn journal: one append-only JSON-lines file per room under
 * the agent's own directory, opened on first use and kept open until the
 * room's handling stops.
 */
export class TurnJournal {
  private readonly rooms = new Map<string, Promise<RoomJournal>>();
  /** Rooms being released; reopening one waits, so it reads every record the closing handle wrote. */
  private readonly releasing = new Map<string, Promise<void>>();
  private readonly dir: string;
  /** Set by `close()` until the next `prepare()`: a turn the runtime stopped waiting on opens no file. */
  private closed = false;

  public constructor(journalDir: string, agentId: string, private readonly options: TurnJournalOptions) {
    // Per agent: a room's file holds what this agent finished, which another agent in the room did not.
    this.dir = agentJournalDir(journalDir, agentId);
  }

  /** Creates the agent's directory and checks it is usable, so a bad `journalDir` fails start, not a turn. */
  public async prepare(): Promise<void> {
    this.closed = false;
    try {
      await mkdir(this.dir, { recursive: true });
      await access(this.dir, constants.R_OK | constants.W_OK | constants.X_OK);
    } catch (error) {
      throw new ValidationError("sessionConfig.journalDir is not a usable directory", error);
    }
  }

  public room(roomId: string): Promise<RoomJournal> {
    if (this.closed) return Promise.reject(new RuntimeStateError("The turn journal is closed; the runtime stopped"));
    let journal = this.rooms.get(roomId);
    if (!journal) {
      const file = roomJournalFile(this.dir, roomId);
      // A failed close was logged where it happened; the reopen reads whatever the file holds.
      const released = (this.releasing.get(roomId) ?? Promise.resolve()).catch(() => undefined);
      journal = released.then(() => RoomJournal.open(file, this.options, roomId));
      this.rooms.set(roomId, journal);
      journal.catch(() => {
        if (this.rooms.get(roomId) === journal) this.rooms.delete(roomId);
      });
    }
    return journal;
  }

  /** Closes `roomId`'s journal once its handling stopped; it reopens on the room's next turn. */
  public release(roomId: string): Promise<void> {
    const journal = this.rooms.get(roomId);
    if (!journal) return this.releasing.get(roomId) ?? Promise.resolve();
    this.rooms.delete(roomId);
    const closing = closeRoom(journal).finally(() => {
      if (this.releasing.get(roomId) === closing) this.releasing.delete(roomId);
    });
    this.releasing.set(roomId, closing);
    return closing;
  }

  /**
   * Closes every room's journal, and opens none until the next `prepare()`.
   * Rejects only for the closes it made: one already releasing reports its
   * failure to whoever released it.
   */
  public async close(): Promise<void> {
    this.closed = true;
    const releasing = [...this.releasing.values()].map((closing) => closing.catch(() => undefined));
    const errors: unknown[] = [];
    await Promise.all([...[...this.rooms.keys()].map((roomId) => isolateTeardown(errors, () => this.release(roomId))), ...releasing]);
    if (errors.length > 0) throw combineTeardownErrors(errors, "Failed to close the turn journal's rooms");
  }
}

async function closeRoom(journal: Promise<RoomJournal>): Promise<void> {
  await (await journal.catch(() => null))?.close();
}

/** Every readable line of `text`, and how many were not. */
function parseLines(text: string): { records: StoredRecord[]; unreadable: number } {
  const records: StoredRecord[] = [];
  let unreadable = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      unreadable += 1;
      continue;
    }
    const parsed = journalRecordSchema.safeParse(json);
    const foreign = parsed.success ? parsed : foreignRecordSchema.safeParse(json);
    if (foreign.success) records.push(foreign.data);
    else unreadable += 1;
  }
  return { records, unreadable };
}

/** The records of every message written to at or after `cutoff`: a message's records expire together. */
function unexpired(records: StoredRecord[], cutoff: number): StoredRecord[] {
  const latest = new Map<string, number>();
  for (const record of records) latest.set(record.messageId, Math.max(record.at, latest.get(record.messageId) ?? record.at));
  return records.filter((record) => (latest.get(record.messageId) ?? 0) >= cutoff);
}

/** Replaces `file` with `records`, through a renamed copy so a crash leaves the old file or the new one. */
async function rewrite(file: string, records: StoredRecord[]): Promise<void> {
  const copy = `${file}.${randomUUID()}.compacting`;
  try {
    const handle = await open(copy, "w");
    try {
      await handle.writeFile(records.map(toLine).join(""), "utf8");
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

const COMPACTING_COPY = /^\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.compacting$/;

/** Removes the copies of `file` a crash left mid-compaction; they never replaced it. */
async function removeOrphanedCopies(file: string): Promise<void> {
  const dir = path.dirname(file);
  const base = path.basename(file);
  for (const name of await readdir(dir)) {
    if (name.startsWith(base) && COMPACTING_COPY.test(name.slice(base.length))) {
      await rm(path.join(dir, name), { force: true });
    }
  }
}

/** Whether `error` is a file system error with `code`. */
function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * Flushes `dir`'s entries, so a file created or renamed in it survives an OS
 * crash, not only a process one. Windows cannot open a directory for this.
 */
async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * One room's record of which inbound messages' turns ended, written before
 * the message is marked processed, and of the replies a turn began posting.
 * Each record is flushed to disk before the call that wrote it resolves.
 *
 * Every record only ever stops a message from being answered twice: losing
 * one, to a failed write or a damaged line, leaves the message to be answered
 * again, as it would be without a journal.
 *
 * A JSON-lines file rather than `node:sqlite` (which the Linear store uses):
 * the journal is opt-in for every runtime, and `node:sqlite` warns as
 * experimental on Node 22 and needs a flag below 22.13, which the engines
 * range still allows.
 */
export class RoomJournal {
  private readonly inbounds = new Map<string, InboundIndex>();
  private readonly writes = new Serializer();
  /** A failed append may have left part of a line; the next one starts a line of its own. */
  private lineCut = false;
  private closed = false;

  private constructor(
    private readonly handle: FileHandle,
    private readonly retentionMs: number,
    private readonly now: () => number,
  ) {}

  public static async open(file: string, options: TurnJournalOptions, roomId: string): Promise<RoomJournal> {
    const now = options.now ?? Date.now;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await removeOrphanedCopies(file);
      const text = await readFile(file, "utf8").catch((error: unknown) => {
        if (hasErrorCode(error, "ENOENT")) return null;
        throw error;
      });
      const { records: readable, unreadable } = parseLines(text ?? "");
      const records = unexpired(readable, now() - options.retentionMs);
      const expired = readable.length - records.length;
      // Rewritten also when a crash cut the last line's newline, so the next append starts a line.
      if (unreadable > 0 || expired > 0 || (text !== null && text !== "" && !text.endsWith("\n"))) {
        if (unreadable > 0) options.logger?.warn("Dropping unreadable turn journal lines", { roomId, unreadable, expired });
        else options.logger?.debug("Compacting a turn journal", { roomId, expired });
        await rewrite(file, records);
      }
      const handle = await open(file, "a");
      try {
        // This open created the file: its directory entry is flushed before the first record.
        if (text === null) await syncDirectory(path.dirname(file));
      } catch (error) {
        await handle.close();
        throw error;
      }
      const journal = new RoomJournal(handle, options.retentionMs, now);
      for (const record of records) journal.apply(record);
      return journal;
    } catch (error) {
      throw journalFailure(error);
    }
  }

  /** Whether this handle closed: its room's handling stopped, and the room's next turn opens a new one. */
  public get isClosed(): boolean {
    return this.closed;
  }

  public inbound(messageId: string): InboundState {
    this.expire();
    const index = this.inbounds.get(messageId);
    return { done: index?.done ?? false, unreportedReplies: index?.unreportedReplies ?? 0 };
  }

  /** Records that a reply to `messageId` is about to begin posting. */
  public async replyBegun(messageId: string): Promise<void> {
    await this.append({ t: "reply.intent", messageId });
  }

  /** Records that the inbound's turn ended, before it is marked processed. */
  public async turnDone(messageId: string): Promise<void> {
    await this.append({ t: "turn.done", messageId });
  }

  /** Records that the message's begun replies were reported as possibly in the room, so they are reported once. */
  public async repliesReported(messageId: string): Promise<void> {
    await this.append({ t: "replies.reported", messageId });
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Queued after every write already accepted.
    await this.writes.run(() => this.handle.close());
  }

  private append(entry: JournalEntry): Promise<void> {
    if (this.closed) {
      return Promise.reject(new RuntimeStateError("The room's turn journal is closed; its handling stopped"));
    }
    return this.writes.run(async () => {
      const record: StoredRecord = { ...entry, at: this.now() };
      const line = `${this.lineCut ? "\n" : ""}${toLine(record)}`;
      try {
        this.lineCut = true;
        await this.handle.appendFile(line, "utf8");
        await this.handle.datasync();
        this.lineCut = false;
      } catch (error) {
        throw journalFailure(error);
      }
      this.apply(record);
      this.expire();
    });
  }

  /** `messageId`'s index, moved to the newest end and stamped `at`. */
  private touch(messageId: string, at: number): InboundIndex {
    const index = this.inbounds.get(messageId) ?? { done: false, unreportedReplies: 0, at };
    this.inbounds.delete(messageId);
    index.at = at;
    this.inbounds.set(messageId, index);
    return index;
  }

  /** Forgets the messages the retention no longer covers; the map is kept oldest first. */
  private expire(): void {
    const cutoff = this.now() - this.retentionMs;
    for (const [messageId, index] of this.inbounds) {
      if (index.at >= cutoff) break;
      this.inbounds.delete(messageId);
    }
  }

  /** Applies `record`; one this version does not know only keeps its message's records from expiring. */
  private apply(record: StoredRecord): void {
    const index = this.touch(record.messageId, record.at);
    switch (record.t) {
      case "reply.intent":
        if (!index.done) index.unreportedReplies += 1;
        return;
      case "turn.done":
        index.done = true;
        index.unreportedReplies = 0;
        return;
      case "replies.reported":
        index.unreportedReplies = 0;
        return;
    }
  }
}
