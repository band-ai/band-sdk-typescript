import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, type FileHandle } from "node:fs/promises";
import path from "node:path";

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
  /** A reply posted or a decline landed for it. */
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

type JournalRecord =
  | ({ t: "reply.intent" } & PendingReply)
  | { t: "reply.posted"; id: string; result: unknown }
  | { t: "reply.failed"; id: string }
  | ({ t: "reply.declined"; messageId: string; result: unknown } & ReplyIdentity)
  | { t: "delivery.unrecorded"; id: string }
  | { t: "turn.done"; messageId: string };

interface InboundIndex {
  answered: boolean;
  done: boolean;
  pending: Map<string, PendingReply>;
}

/**
 * Every room's turn journal under one directory: one append-only JSON-lines
 * file per room, opened on first use and kept open.
 */
export class TurnJournal {
  private readonly rooms = new Map<string, Promise<RoomJournal>>();

  public constructor(private readonly dir: string) {}

  public room(roomId: string): Promise<RoomJournal> {
    let journal = this.rooms.get(roomId);
    if (!journal) {
      journal = RoomJournal.open(path.join(this.dir, `${encodeURIComponent(roomId)}.jsonl`));
      this.rooms.set(roomId, journal);
      journal.catch(() => {
        if (this.rooms.get(roomId) === journal) this.rooms.delete(roomId);
      });
    }
    return journal;
  }

  public async close(): Promise<void> {
    const rooms = [...this.rooms.values()];
    this.rooms.clear();
    await Promise.all(rooms.map(async (room) => (await room.catch(() => null))?.close()));
  }
}

/**
 * One room's record of what each inbound turn answered, written before the
 * runtime acts on it: a reply's intent before its post, its outcome after,
 * and a turn's end before the inbound is marked processed. Each record is
 * flushed to disk before the call that wrote it resolves. A last line a
 * crash cut short is ignored.
 */
export class RoomJournal {
  private readonly inbounds = new Map<string, InboundIndex>();
  private readonly pendingById = new Map<string, PendingReply>();
  private readonly operations = new Map<string, RecordedOperation>();
  private writes: Promise<void> = Promise.resolve();
  private separate: boolean;

  private constructor(private readonly handle: FileHandle, text: string) {
    const lines = text.split("\n");
    for (const line of lines) {
      if (line.trim() === "") continue;
      let record: JournalRecord;
      try {
        record = JSON.parse(line) as JournalRecord;
      } catch {
        continue;
      }
      this.apply(record);
    }
    this.separate = text.length > 0 && !text.endsWith("\n");
  }

  public static async open(file: string): Promise<RoomJournal> {
    await mkdir(path.dirname(file), { recursive: true });
    const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    return new RoomJournal(await open(file, "a"), text);
  }

  public inbound(messageId: string): InboundState {
    const index = this.inbounds.get(messageId);
    return {
      answered: index?.answered ?? false,
      done: index?.done ?? false,
      unrecorded: index ? [...index.pending.values()] : [],
    };
  }

  public operation(operationId: string): RecordedOperation | undefined {
    return this.operations.get(operationId);
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

  /** Records that the inbound's turn ended, before it is marked processed. */
  public async turnDone(messageId: string): Promise<void> {
    await this.append({ t: "turn.done", messageId });
  }

  public async close(): Promise<void> {
    await this.writes.catch(() => undefined);
    await this.handle.close();
  }

  private append(record: JournalRecord): Promise<void> {
    const write = this.writes.then(async () => {
      const line = `${this.separate ? "\n" : ""}${JSON.stringify(record)}\n`;
      await this.handle.appendFile(line, "utf8");
      await this.handle.datasync();
      this.separate = false;
      this.apply(record);
    });
    // A failed write fails its own caller; the next one still runs.
    this.writes = write.catch(() => undefined);
    return write;
  }

  private indexFor(messageId: string): InboundIndex {
    let index = this.inbounds.get(messageId);
    if (!index) {
      index = { answered: false, done: false, pending: new Map() };
      this.inbounds.set(messageId, index);
    }
    return index;
  }

  private apply(record: JournalRecord): void {
    switch (record.t) {
      case "reply.intent": {
        const { t: _t, ...pending } = record;
        this.pendingById.set(pending.id, pending);
        this.indexFor(pending.messageId).pending.set(pending.id, pending);
        return;
      }
      case "reply.posted": {
        const pending = this.settle(record.id);
        if (!pending) return;
        this.indexFor(pending.messageId).answered = true;
        if (pending.operationId !== undefined) {
          this.operations.set(pending.operationId, { tool: pending.tool, digest: pending.digest, result: record.result });
        }
        return;
      }
      case "reply.failed":
      case "delivery.unrecorded":
        this.settle(record.id);
        return;
      case "reply.declined":
        this.indexFor(record.messageId).answered = true;
        if (record.operationId !== undefined) {
          this.operations.set(record.operationId, { tool: record.tool, digest: record.digest, result: record.result });
        }
        return;
      case "turn.done":
        this.indexFor(record.messageId).done = true;
        return;
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
