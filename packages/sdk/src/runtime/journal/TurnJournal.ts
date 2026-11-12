import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { RuntimeStateError } from "../../core/errors";

/** The Band tools whose landing answers an inbound turn. */
export type ReplyTool = "band_send_message" | "band_no_reply";

export interface ReplyIdentity {
  tool: ReplyTool;
  /** Digest of the reply's payload; an operation id is bound to it. */
  digest: string;
  operationId?: string;
}

/** A reply whose post began; `id` pairs it with how it ended. */
export interface PendingReply extends ReplyIdentity {
  id: string;
  messageId: string;
}

/** What the journal knows of one inbound message's turn. */
export interface InboundState {
  /** A reply posted or a decline landed for it since its last retry. */
  answered: boolean;
  /** Its turn ended and the inbound is about to be, or was, marked processed. */
  done: boolean;
  /** Replies whose post began but whose outcome was never recorded: delivery uncertain. */
  unrecorded: PendingReply[];
}

/** A posted or declined reply recorded under an operation id. */
export interface RecordedOperation {
  tool: ReplyTool;
  digest: string;
  result: unknown;
}

type JournalEntry =
  | ({ t: "reply.intent" } & PendingReply)
  | { t: "reply.posted"; id: string; result: unknown }
  | { t: "reply.failed"; id: string }
  | ({ t: "reply.declined"; messageId: string; result: unknown } & ReplyIdentity)
  | { t: "delivery.unrecorded"; id: string }
  | { t: "turn.done"; messageId: string }
  | { t: "turn.retried"; messageId: string };

/** A journal line: an entry stamped with when it was written, in epoch milliseconds. */
type JournalRecord = JournalEntry & { at: number };

interface InboundIndex {
  answered: boolean;
  done: boolean;
  pending: Map<string, PendingReply>;
  /** When a record last touched it; the index is kept in this order. */
  at: number;
}

interface StoredOperation extends RecordedOperation {
  at: number;
}

export interface TurnJournalOptions {
  /**
   * How long a record counts. An older one is forgotten: its operation id
   * dedupes nothing, and its message is answered again if Band still serves
   * it. Expired records are dropped from a room's file when it opens.
   */
  retentionMs: number;
  /** The clock records are stamped and expired by; `Date.now` by default. */
  now?: () => number;
}

/**
 * Every room's turn journal under one directory: one append-only JSON-lines
 * file per room, opened on first use and kept open.
 */
export class TurnJournal {
  private readonly rooms = new Map<string, Promise<RoomJournal>>();
  /** Rooms being released; reopening one waits, so it reads every record the closing handle wrote. */
  private readonly releasing = new Map<string, Promise<void>>();

  public constructor(private readonly dir: string, private readonly options: TurnJournalOptions) {}

  public room(roomId: string): Promise<RoomJournal> {
    let journal = this.rooms.get(roomId);
    if (!journal) {
      const file = path.join(this.dir, `${encodeURIComponent(roomId)}.jsonl`);
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
    await Promise.all([...rooms.map(closeRoom), ...this.releasing.values()]);
  }
}

async function closeRoom(journal: Promise<RoomJournal>): Promise<void> {
  await (await journal.catch(() => null))?.close();
}

/**
 * The records in `text` written at or after `cutoff`; `dropped` when any line
 * was left out, expired or unreadable (a last line a crash cut short).
 */
function readRecords(text: string, cutoff: number): { records: JournalRecord[]; dropped: boolean } {
  const records: JournalRecord[] = [];
  let dropped = false;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let record: JournalRecord;
    try {
      record = JSON.parse(line) as JournalRecord;
    } catch {
      dropped = true;
      continue;
    }
    if (typeof record.at !== "number" || record.at < cutoff) {
      dropped = true;
      continue;
    }
    records.push(record);
  }
  return { records, dropped };
}

/** Replaces `file` with `records`, through a renamed copy so a crash leaves the old file or the new one. */
async function rewrite(file: string, records: JournalRecord[]): Promise<void> {
  const copy = `${file}.compacting`;
  const handle = await open(copy, "w");
  try {
    await handle.writeFile(records.map((record) => `${JSON.stringify(record)}\n`).join(""), "utf8");
    await handle.datasync();
  } finally {
    await handle.close();
  }
  await rename(copy, file);
}

/**
 * One room's record of what each inbound turn answered, written before the
 * runtime acts on it: a reply's intent before its post, its outcome after,
 * and a turn's end before the inbound is marked processed. Each record is
 * flushed to disk before the call that wrote it resolves.
 *
 * Memory holds only what this process can still need. A message whose turn
 * ended here is forgotten at once: the room's execution never runs a message
 * twice, and a restart reads its end back from the file. Records older than
 * the retention are forgotten, and dropped from the file when it opens.
 */
export class RoomJournal {
  private readonly inbounds = new Map<string, InboundIndex>();
  private readonly pendingById = new Map<string, PendingReply>();
  private readonly operations = new Map<string, StoredOperation>();
  private readonly retentionMs: number;
  private readonly now: () => number;
  private writes: Promise<void> = Promise.resolve();
  private separate: boolean;
  private closed = false;

  private constructor(private readonly handle: FileHandle, options: TurnJournalOptions, separate: boolean) {
    this.retentionMs = options.retentionMs;
    this.now = options.now ?? Date.now;
    this.separate = separate;
  }

  public static async open(file: string, options: TurnJournalOptions): Promise<RoomJournal> {
    await mkdir(path.dirname(file), { recursive: true });
    const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const { records, dropped } = readRecords(text, (options.now ?? Date.now)() - options.retentionMs);
    if (dropped) await rewrite(file, records);
    const separate = !dropped && text.length > 0 && !text.endsWith("\n");
    const journal = new RoomJournal(await open(file, "a"), options, separate);
    for (const record of records) journal.apply(record, "read");
    return journal;
  }

  public inbound(messageId: string): InboundState {
    this.expire();
    const index = this.inbounds.get(messageId);
    return {
      answered: index?.answered ?? false,
      done: index?.done ?? false,
      unrecorded: index ? [...index.pending.values()] : [],
    };
  }

  public operation(operationId: string): RecordedOperation | undefined {
    this.expire();
    const stored = this.operations.get(operationId);
    return stored && { tool: stored.tool, digest: stored.digest, result: stored.result };
  }

  /** Records that a reply's post is about to begin. */
  public async beginReply(messageId: string, identity: ReplyIdentity): Promise<PendingReply> {
    const pending: PendingReply = { id: randomUUID(), messageId, ...identity };
    await this.append({ t: "reply.intent", ...pending });
    return pending;
  }

  /** Records that Band accepted the reply. */
  public async replyPosted(pending: PendingReply, result: unknown): Promise<void> {
    await this.append({ t: "reply.posted", id: pending.id, result });
  }

  /** Records that the reply's post failed: it is not pending anymore, and nothing was posted. */
  public async replyFailed(pending: PendingReply): Promise<void> {
    await this.append({ t: "reply.failed", id: pending.id });
  }

  /** Records a decline, which posts nothing. */
  public async replyDeclined(messageId: string, identity: ReplyIdentity, result: unknown = { status: "ok" }): Promise<void> {
    await this.append({ t: "reply.declined", messageId, ...identity, result });
  }

  /**
   * Records that a pending reply's delivery is uncertain: its post began, and
   * nothing records how it ended. It may or may not have reached Band. This
   * never means the post was accepted; nothing may treat it as delivered.
   */
  public async deliveryUnrecorded(pending: PendingReply): Promise<void> {
    await this.append({ t: "delivery.unrecorded", id: pending.id });
  }

  /** Records that the inbound's turn ended, before it is marked processed; memory forgets it. */
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
    await this.writes;
    await this.handle.close();
  }

  private append(entry: JournalEntry): Promise<void> {
    if (this.closed) {
      return Promise.reject(new RuntimeStateError("The room's turn journal is closed; its handling stopped"));
    }
    const write = this.writes.then(async () => {
      const record: JournalRecord = { ...entry, at: this.now() };
      const line = `${this.separate ? "\n" : ""}${JSON.stringify(record)}\n`;
      await this.handle.appendFile(line, "utf8");
      await this.handle.datasync();
      this.separate = false;
      this.apply(record, "written");
      this.expire();
    });
    // A failed write fails its own caller; the next one still runs.
    this.writes = write.catch(() => undefined);
    return write;
  }

  /** `messageId`'s index, moved to the newest end and stamped `at`. */
  private touch(messageId: string, at: number): InboundIndex {
    const index = this.inbounds.get(messageId) ?? { answered: false, done: false, pending: new Map(), at };
    this.inbounds.delete(messageId);
    index.at = at;
    this.inbounds.set(messageId, index);
    return index;
  }

  private remember(operationId: string, operation: RecordedOperation, at: number): void {
    this.operations.delete(operationId);
    this.operations.set(operationId, { ...operation, at });
  }

  private forget(messageId: string): void {
    const index = this.inbounds.get(messageId);
    if (!index) return;
    for (const id of index.pending.keys()) this.pendingById.delete(id);
    this.inbounds.delete(messageId);
  }

  /** Forgets what the retention no longer covers; both maps are kept oldest first. */
  private expire(): void {
    const cutoff = this.now() - this.retentionMs;
    for (const [messageId, index] of this.inbounds) {
      if (index.at >= cutoff) break;
      this.forget(messageId);
    }
    for (const [operationId, operation] of this.operations) {
      if (operation.at >= cutoff) break;
      this.operations.delete(operationId);
    }
  }

  private apply(record: JournalRecord, source: "read" | "written"): void {
    switch (record.t) {
      case "reply.intent": {
        const { t: _t, at, ...pending } = record;
        this.pendingById.set(pending.id, pending);
        this.touch(pending.messageId, at).pending.set(pending.id, pending);
        return;
      }
      case "reply.posted": {
        const pending = this.settle(record.id);
        if (!pending) return;
        this.touch(pending.messageId, record.at).answered = true;
        if (pending.operationId !== undefined) {
          this.remember(pending.operationId, { tool: pending.tool, digest: pending.digest, result: record.result }, record.at);
        }
        return;
      }
      case "reply.failed":
      case "delivery.unrecorded":
        this.settle(record.id);
        return;
      case "reply.declined":
        this.touch(record.messageId, record.at).answered = true;
        if (record.operationId !== undefined) {
          this.remember(record.operationId, { tool: record.tool, digest: record.digest, result: record.result }, record.at);
        }
        return;
      case "turn.done":
        // Read back, it is what keeps a restart from answering again; written here, the execution already does.
        if (source === "read") this.touch(record.messageId, record.at).done = true;
        else this.forget(record.messageId);
        return;
      case "turn.retried": {
        const index = this.touch(record.messageId, record.at);
        index.answered = false;
        for (const id of index.pending.keys()) this.pendingById.delete(id);
        index.pending.clear();
        return;
      }
    }
  }

  private settle(id: string): PendingReply | undefined {
    const pending = this.pendingById.get(id);
    if (!pending) return undefined;
    this.pendingById.delete(id);
    this.inbounds.get(pending.messageId)?.pending.delete(id);
    return pending;
  }
}
