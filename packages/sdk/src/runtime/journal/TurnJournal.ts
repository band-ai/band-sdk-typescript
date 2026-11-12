import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { RuntimeStateError } from "../../core/errors";
import { Serializer } from "../../core/singleFlight";
import { combineTeardownErrors, isolateTeardown } from "../../core/teardown";

/** The Band tools whose landing answers an inbound turn. */
export type ReplyTool = "band_send_message" | "band_no_reply";

/** A reply's tool, and the operation id and payload digest it is bound to when it carries one. */
export type ReplyIdentity = { tool: ReplyTool } & (
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

/** A posted or declined reply recorded under an operation id. */
export interface RecordedOperation {
  tool: ReplyTool;
  digest: string;
  result: unknown;
}

/** How a pending reply ended; `result` is kept only for a reply under an operation id, the one a retry replays. */
type Outcome = { id: string; messageId: string };

type JournalEntry =
  | ({ t: "reply.intent" } & PendingReply)
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
  pending: Map<string, PendingReply>;
  /** When a record last touched it; the index is kept in this order. */
  at: number;
}

interface StoredOperation extends RecordedOperation {
  at: number;
}

/** The path of `roomId`'s journal under `dir`. */
export function roomJournalFile(dir: string, roomId: string): string {
  return path.join(dir, `${encodeURIComponent(roomId)}.jsonl`);
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

/**
 * The records in `text` written at or after `cutoff`; `dropped` when the file
 * needs rewriting: a line was left out, expired or unreadable, or a crash cut
 * the last line's newline.
 */
function readRecords(text: string, cutoff: number): { records: JournalRecord[]; dropped: boolean } {
  const records: JournalRecord[] = [];
  let dropped = text.length > 0 && !text.endsWith("\n");
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
  private readonly operations = new Map<string, StoredOperation>();
  /** Replies under one operation id land one at a time, so a racing retry sees the first one's record. */
  private readonly landing = new Map<string, Promise<unknown>>();
  private readonly writes = new Serializer();
  private closed = false;

  private constructor(
    private readonly handle: FileHandle,
    private readonly retentionMs: number,
    private readonly now: () => number,
  ) {}

  public static async open(file: string, options: TurnJournalOptions): Promise<RoomJournal> {
    const now = options.now ?? Date.now;
    await mkdir(path.dirname(file), { recursive: true });
    const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const { records, dropped } = readRecords(text, now() - options.retentionMs);
    if (dropped) await rewrite(file, records);
    const journal = new RoomJournal(await open(file, "a"), options.retentionMs, now);
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

  /**
   * Runs `land` once no other reply under `operationId` is landing, so a
   * racing retry runs after the first and sees what it recorded.
   */
  public async once<T>(operationId: string, land: () => Promise<T>): Promise<T> {
    for (let previous = this.landing.get(operationId); previous; previous = this.landing.get(operationId)) {
      await previous.catch(() => undefined);
    }
    const landing = land();
    this.landing.set(operationId, landing);
    try {
      return await landing;
    } finally {
      if (this.landing.get(operationId) === landing) this.landing.delete(operationId);
    }
  }

  /** Drops a message from memory; its records stay in the file. */
  public forget(messageId: string): void {
    this.inbounds.delete(messageId);
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

  /** Records that the reply's post failed: it is not pending anymore, and nothing was posted. */
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
    // Queued after every write already accepted.
    await this.writes.run(() => this.handle.close());
  }

  private append(entry: JournalEntry): Promise<void> {
    if (this.closed) {
      return Promise.reject(new RuntimeStateError("The room's turn journal is closed; its handling stopped"));
    }
    return this.writes.run(async () => {
      const record: JournalRecord = { ...entry, at: this.now() };
      await this.handle.appendFile(`${JSON.stringify(record)}\n`, "utf8");
      await this.handle.datasync();
      this.apply(record, "written");
      this.expire();
    });
  }

  /** `messageId`'s index, moved to the newest end and stamped `at`. */
  private touch(messageId: string, at: number): InboundIndex {
    const index = this.inbounds.get(messageId) ?? { answered: false, done: false, pending: new Map(), at };
    this.inbounds.delete(messageId);
    index.at = at;
    this.inbounds.set(messageId, index);
    return index;
  }

  /** Marks `messageId` answered, and keeps the reply's result under its operation id for a retry to replay. */
  private answered(messageId: string, identity: ReplyIdentity, result: unknown, at: number): void {
    this.touch(messageId, at).answered = true;
    if (identity.operationId === undefined) return;
    this.operations.delete(identity.operationId);
    this.operations.set(identity.operationId, { tool: identity.tool, digest: identity.digest, result, at });
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
        this.touch(pending.messageId, at).pending.set(pending.id, pending);
        return;
      }
      case "reply.posted": {
        const pending = this.settle(record);
        if (pending) this.answered(pending.messageId, pending, record.result, record.at);
        return;
      }
      case "reply.failed":
      case "delivery.unrecorded":
        this.settle(record);
        return;
      case "reply.declined":
        this.answered(record.messageId, record, record.result, record.at);
        return;
      case "turn.done":
        // Read back, it is what keeps a restart from answering again; written here, the execution already does.
        if (source === "read") this.touch(record.messageId, record.at).done = true;
        else this.forget(record.messageId);
        return;
      case "turn.retried": {
        const index = this.touch(record.messageId, record.at);
        index.answered = false;
        index.pending.clear();
        return;
      }
    }
  }

  /** The pending reply `outcome` ends, taken off its message; none when a retry or forget already dropped it. */
  private settle(outcome: Outcome): PendingReply | undefined {
    const pending = this.inbounds.get(outcome.messageId)?.pending;
    const reply = pending?.get(outcome.id);
    pending?.delete(outcome.id);
    return reply;
  }
}

function outcomeOf(pending: PendingReply): Outcome {
  return { id: pending.id, messageId: pending.messageId };
}

/** `result`, kept only for a reply under an operation id: nothing else replays it. */
function replayable(identity: ReplyIdentity, result: unknown): { result?: unknown } {
  return identity.operationId === undefined ? {} : { result };
}
