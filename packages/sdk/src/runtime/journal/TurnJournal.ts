import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, rename, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { REPLY_TOOL_NAMES, type ReplyToolName } from "../../contracts/toolSchemas";
import { RecoverableTurnError, RuntimeStateError, ValidationError } from "../../core/errors";
import type { Logger } from "../../core/logger";
import { KeyedSerializer, Serializer } from "../../core/singleFlight";
import { combineTeardownErrors, isolateTeardown } from "../../core/teardown";

/** A reply's tool, and the operation id and payload digest it is bound to when it carries one. */
export type ReplyIdentity = { tool: ReplyToolName } & (
  | { operationId?: undefined; digest?: undefined }
  | { operationId: string; digest: string }
);

/** A reply whose post began; `id` pairs it with how it ended. */
export type PendingReply = ReplyIdentity & {
  id: string;
  messageId: string;
};

/** What the journal knows of one inbound message's turn. */
export interface InboundState {
  /** A reply posted or a decline landed for it since its last retry. */
  answered: boolean;
  /** Its turn ended and the inbound is about to be, or was, marked processed. */
  done: boolean;
  /** Replies whose post began but whose outcome was never recorded: delivery uncertain. */
  unrecorded: PendingReply[];
}

/** What a reply under an operation id is known to have done. */
export type RecordedOperation =
  | { status: "landed"; tool: ReplyToolName; digest: string; result: unknown }
  /** Its post began and how it ended is unknown: Band may or may not have it. */
  | { status: "uncertain"; tool: ReplyToolName; digest: string };

const recordFields = { at: z.number(), messageId: z.string() };
const identityFields = {
  tool: z.enum(REPLY_TOOL_NAMES),
  operationId: z.string().optional(),
  digest: z.string().optional(),
};
const outcomeFields = { ...recordFields, id: z.string() };

/** A journal line as read back from disk: every record names its message and when it was written. */
const journalRecordSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("reply.intent"), ...outcomeFields, ...identityFields }),
  z.object({ t: z.literal("reply.posted"), ...outcomeFields, result: z.unknown().optional() }),
  z.object({ t: z.literal("reply.failed"), ...outcomeFields }),
  z.object({ t: z.literal("delivery.unrecorded"), ...outcomeFields }),
  z.object({ t: z.literal("reply.declined"), ...recordFields, ...identityFields, result: z.unknown().optional() }),
  z.object({ t: z.literal("turn.done"), ...recordFields }),
  z.object({ t: z.literal("turn.retried"), ...recordFields }),
]);

/** Which pending reply an outcome record ends. */
type Outcome = { id: string; messageId: string };

type JournalEntry =
  | ({ t: "reply.intent" } & PendingReply)
  /** `result` is kept only for a reply under an operation id: nothing else replays it. */
  | ({ t: "reply.posted"; result?: unknown } & Outcome)
  | ({ t: "reply.failed" } & Outcome)
  | ({ t: "reply.declined"; messageId: string; result?: unknown } & ReplyIdentity)
  | ({ t: "delivery.unrecorded" } & Outcome)
  | { t: "turn.done"; messageId: string }
  | { t: "turn.retried"; messageId: string };

/** A journal line: an entry stamped with when it was written, in epoch milliseconds. */
type JournalRecord = JournalEntry & { at: number };

interface InboundIndex {
  answered: boolean;
  done: boolean;
  /** Replies begun before the last retry: landing, they no longer answer the inbound. */
  stale: Set<string>;
  /** When a record last touched it; the index is kept in this order. */
  at: number;
}

/** A remembered value and when it was last written, which is when it expires from. */
type Dated<T> = { value: T; at: number };

/** The directory of one agent's journal under `journalDir`. */
export function agentJournalDir(journalDir: string, agentId: string): string {
  return path.join(journalDir, encodeURIComponent(agentId));
}

/** The path of `roomId`'s journal under an agent's journal directory. */
export function roomJournalFile(dir: string, roomId: string): string {
  return path.join(dir, `${encodeURIComponent(roomId)}.jsonl`);
}

function toLine(record: JournalRecord): string {
  return `${JSON.stringify(record)}\n`;
}

export interface TurnJournalOptions {
  /**
   * How long a message's records count, from the last one written for it.
   * Past that it is forgotten: its operation ids dedupe nothing, and it is
   * answered again if Band still serves it. Expired records are dropped from
   * a room's file when it opens.
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

  public constructor(journalDir: string, agentId: string, private readonly options: TurnJournalOptions) {
    // Per agent: a room's file holds what this agent answered, which another agent in the room did not.
    this.dir = agentJournalDir(journalDir, agentId);
  }

  /** Creates the agent's directory and checks it is writable, so a bad `journalDir` fails start, not a turn. */
  public async prepare(): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      await access(this.dir, constants.W_OK);
    } catch (error) {
      throw new ValidationError(`sessionConfig.journalDir is not a writable directory: ${this.dir}`, error);
    }
  }

  public room(roomId: string): Promise<RoomJournal> {
    let journal = this.rooms.get(roomId);
    if (!journal) {
      const file = roomJournalFile(this.dir, roomId);
      const released = this.releasing.get(roomId) ?? Promise.resolve();
      journal = released.then(() => RoomJournal.open(file, this.options));
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

  public async close(): Promise<void> {
    const rooms = [...this.rooms.values()];
    this.rooms.clear();
    const errors: unknown[] = [];
    await Promise.all([...rooms.map(closeRoom), ...this.releasing.values()].map((closing) => isolateTeardown(errors, () => closing)));
    if (errors.length > 0) throw combineTeardownErrors(errors, "Failed to close the turn journal's rooms");
  }
}

async function closeRoom(journal: Promise<RoomJournal>): Promise<void> {
  await (await journal.catch(() => null))?.close();
}

/** Every readable line of `text`, and how many were not. */
function parseLines(text: string): { records: JournalRecord[]; unreadable: number } {
  const records: JournalRecord[] = [];
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
    if (parsed.success) {
      // The schema checks each field; the pairing of an operation id with its digest is the writer's.
      records.push(parsed.data as JournalRecord);
    } else {
      unreadable += 1;
    }
  }
  return { records, unreadable };
}

/** The records of every message written to at or after `cutoff`: a message's records expire together. */
function unexpired(records: JournalRecord[], cutoff: number): JournalRecord[] {
  const latest = new Map<string, number>();
  for (const record of records) latest.set(record.messageId, Math.max(record.at, latest.get(record.messageId) ?? record.at));
  return records.filter((record) => (latest.get(record.messageId) ?? 0) >= cutoff);
}

/** Replaces `file` with `records`, through a renamed copy so a crash leaves the old file or the new one. */
async function rewrite(file: string, records: JournalRecord[]): Promise<void> {
  const copy = `${file}.compacting`;
  const handle = await open(copy, "w");
  try {
    await handle.writeFile(records.map(toLine).join(""), "utf8");
    await handle.datasync();
  } finally {
    await handle.close();
  }
  await rename(copy, file);
  await syncDirectory(path.dirname(file));
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
 * One room's record of what each inbound turn answered, written before the
 * runtime acts on it: a reply's intent before its post, its outcome after,
 * and a turn's end before the inbound is marked processed. Each record is
 * flushed to disk before the call that wrote it resolves.
 *
 * Memory holds a finished message only as its end marker, and only for the
 * retention; a reply still landing for it, or one whose outcome was never
 * recorded, is kept until its outcome or expiry.
 */
export class RoomJournal {
  private readonly inbounds = new Map<string, InboundIndex>();
  /** Replies whose post began and has no recorded outcome, oldest first. */
  private readonly pending = new Map<string, Dated<PendingReply>>();
  private readonly operations = new Map<string, Dated<RecordedOperation>>();
  /** Replies under one operation id land one at a time, so a racing retry sees the first one's record. */
  private readonly landing = new KeyedSerializer();
  private readonly writes = new Serializer();
  private closed = false;

  private constructor(
    private readonly handle: FileHandle,
    private readonly file: string,
    private readonly retentionMs: number,
    private readonly now: () => number,
  ) {}

  public static async open(file: string, options: TurnJournalOptions): Promise<RoomJournal> {
    const now = options.now ?? Date.now;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      const { records: readable, unreadable } = parseLines(text ?? "");
      const records = unexpired(readable, now() - options.retentionMs);
      const expired = readable.length - records.length;
      // Rewritten also when a crash cut the last line's newline, so the next append starts a line.
      if (unreadable > 0 || expired > 0 || (text !== null && text !== "" && !text.endsWith("\n"))) {
        options.logger?.warn("Compacting a turn journal", { file, expired, unreadable });
        await rewrite(file, records);
      }
      const journal = new RoomJournal(await open(file, "a"), file, options.retentionMs, now);
      if (text === null) await syncDirectory(path.dirname(file));
      for (const record of records) journal.apply(record);
      return journal;
    } catch (error) {
      throw journalFailure(file, error);
    }
  }

  public inbound(messageId: string): InboundState {
    this.expire();
    const index = this.inbounds.get(messageId);
    return {
      answered: index?.answered ?? false,
      done: index?.done ?? false,
      unrecorded: [...this.pending.values()].map((entry) => entry.value).filter((reply) => reply.messageId === messageId),
    };
  }

  /**
   * What the reply under `operationId` did. Called inside {@link once}, a
   * reply still pending under the id is not landing: its outcome is uncertain.
   */
  public operation(operationId: string): RecordedOperation | undefined {
    this.expire();
    const stored = this.operations.get(operationId);
    if (stored) return stored.value;
    const reply = [...this.pending.values()].map((entry) => entry.value).find((candidate) => candidate.operationId === operationId);
    return reply?.operationId === undefined ? undefined : { status: "uncertain", tool: reply.tool, digest: reply.digest };
  }

  /** Runs `land` once no other reply under `operationId` is landing, so a racing retry sees what the first recorded. */
  public once<T>(operationId: string, land: () => Promise<T>): Promise<T> {
    return this.landing.run(operationId, land);
  }

  /** Records that a reply's post is about to begin. */
  public async beginReply(messageId: string, identity: ReplyIdentity): Promise<PendingReply> {
    const pending: PendingReply = { id: randomUUID(), messageId, ...identity };
    await this.append({ t: "reply.intent", ...pending });
    return pending;
  }

  /** Records that Band accepted the reply. */
  public async replyPosted(pending: PendingReply, result: unknown): Promise<void> {
    await this.append({ t: "reply.posted", ...outcomeOf(pending), ...replayable(pending, result) });
  }

  /** Records that Band refused the reply: it is not pending anymore, and nothing was posted. */
  public async replyFailed(pending: PendingReply): Promise<void> {
    await this.append({ t: "reply.failed", ...outcomeOf(pending) });
  }

  /** Records a decline, which posts nothing. */
  public async replyDeclined(messageId: string, identity: ReplyIdentity, result: unknown): Promise<void> {
    await this.append({ t: "reply.declined", messageId, ...identity, ...replayable(identity, result) });
  }

  /**
   * Records that a pending reply's delivery is uncertain: its post began, and
   * nothing records how it ended. It may or may not have reached Band. This
   * never means the post was accepted; nothing may treat it as delivered.
   */
  public async deliveryUnrecorded(pending: PendingReply): Promise<void> {
    await this.append({ t: "delivery.unrecorded", ...outcomeOf(pending) });
  }

  /** Records that the inbound's turn ended, before it is marked processed. */
  public async turnDone(messageId: string): Promise<void> {
    await this.append({ t: "turn.done", messageId });
  }

  /**
   * Records that the inbound runs again, failed or stopped: what its turn
   * answered so far no longer answers it, and a reply of that turn still in
   * flight no longer counts.
   */
  public async turnRetried(messageId: string): Promise<void> {
    await this.append({ t: "turn.retried", messageId });
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
      const record: JournalRecord = { ...entry, at: this.now() };
      try {
        await this.handle.appendFile(toLine(record), "utf8");
        await this.handle.datasync();
      } catch (error) {
        throw journalFailure(this.file, error);
      }
      this.apply(record);
      this.expire();
    });
  }

  /** `messageId`'s index, moved to the newest end and stamped `at`. */
  private touch(messageId: string, at: number): InboundIndex {
    const index = this.inbounds.get(messageId) ?? { answered: false, done: false, stale: new Set(), at };
    this.inbounds.delete(messageId);
    index.at = at;
    this.inbounds.set(messageId, index);
    return index;
  }

  private remember(operationId: string, operation: RecordedOperation, at: number): void {
    this.operations.delete(operationId);
    this.operations.set(operationId, { value: operation, at });
  }

  /** Forgets what the retention no longer covers; every map is kept oldest first. */
  private expire(): void {
    const cutoff = this.now() - this.retentionMs;
    for (const map of [this.inbounds, this.pending, this.operations] as Map<string, { at: number }>[]) {
      for (const [key, entry] of map) {
        if (entry.at >= cutoff) break;
        map.delete(key);
      }
    }
  }

  /** The pending reply `outcome` ends, taken off the pending set. */
  private settle(outcome: Outcome, at: number): { reply: PendingReply | undefined; index: InboundIndex } {
    const reply = this.pending.get(outcome.id)?.value;
    this.pending.delete(outcome.id);
    const index = this.touch(outcome.messageId, at);
    index.stale.delete(outcome.id);
    return { reply, index };
  }

  private apply(record: JournalRecord): void {
    switch (record.t) {
      case "reply.intent": {
        const { t: _t, at, ...reply } = record;
        this.pending.set(reply.id, { value: reply, at });
        this.touch(reply.messageId, at);
        return;
      }
      case "reply.posted": {
        const stale = this.inbounds.get(record.messageId)?.stale.has(record.id) ?? false;
        const { reply, index } = this.settle(record, record.at);
        if (!stale) index.answered = true;
        if (reply?.operationId !== undefined) {
          this.remember(reply.operationId, { status: "landed", tool: reply.tool, digest: reply.digest, result: record.result }, record.at);
        }
        return;
      }
      case "reply.failed":
        this.settle(record, record.at);
        return;
      case "delivery.unrecorded": {
        const { reply } = this.settle(record, record.at);
        if (reply?.operationId !== undefined) {
          this.remember(reply.operationId, { status: "uncertain", tool: reply.tool, digest: reply.digest }, record.at);
        }
        return;
      }
      case "reply.declined":
        this.touch(record.messageId, record.at).answered = true;
        if (record.operationId !== undefined) {
          this.remember(record.operationId, { status: "landed", tool: record.tool, digest: record.digest, result: record.result }, record.at);
        }
        return;
      case "turn.done":
        this.touch(record.messageId, record.at).done = true;
        return;
      case "turn.retried": {
        const index = this.touch(record.messageId, record.at);
        index.answered = false;
        for (const { value: reply } of this.pending.values()) {
          if (reply.messageId === record.messageId) index.stale.add(reply.id);
        }
        return;
      }
    }
  }
}

function outcomeOf(pending: PendingReply): Outcome {
  return { id: pending.id, messageId: pending.messageId };
}

/** `result`, kept only for a reply under an operation id: nothing else replays it. */
function replayable(identity: ReplyIdentity, result: unknown): { result?: unknown } {
  return identity.operationId === undefined ? {} : { result };
}

/** A journal read or write failure, confined to the turn that hit it. */
function journalFailure(file: string, error: unknown): RecoverableTurnError {
  return error instanceof RecoverableTurnError ? error : new RecoverableTurnError(`Turn journal I/O failed: ${file}`, error);
}
