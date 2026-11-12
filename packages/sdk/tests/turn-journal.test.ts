import { appendFile, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { BandSdkError, RuntimeStateError, ValidationError } from "../src/core/errors";
import { createDeferred } from "../src/core/deferred";
import type { Logger } from "../src/core/logger";
import { agentJournalDir, RoomJournal, roomJournalFile, TurnJournal } from "../src/runtime/journal/TurnJournal";
import { DEFAULT_JOURNAL_RETENTION_SECONDS } from "../src/runtime/types";
import { MS_PER_SECOND } from "../src/core/deadline";
import { RecordLog, tmpRoot } from "./testUtils";

const AGENT = "agent/one";
const ROOM = "room/with:odd chars";
const RETENTION_MS = DEFAULT_JOURNAL_RETENTION_SECONDS * MS_PER_SECOND;

interface Logged {
  level: "debug" | "warn";
  message: string;
  context: unknown;
}

/** A logger recording its debug and warn lines. */
function recordingLogger(): { logger: Logger; logged: RecordLog<Logged> } {
  const logged = new RecordLog<Logged>();
  const logger: Logger = {
    debug: (message, context) => logged.record({ level: "debug", message, context }),
    info: () => undefined,
    warn: (message, context) => logged.record({ level: "warn", message, context }),
    error: () => undefined,
  };
  return { logger, logged };
}

/** One agent's journal under `dir`, on `clock` when given; closed when the test ends. */
function journalIn(dir: string, options: { clock?: { now: number }; agentId?: string; logger?: Logger } = {}): TurnJournal {
  const { clock, agentId = AGENT, logger } = options;
  const journals = new TurnJournal(dir, agentId, {
    retentionMs: RETENTION_MS,
    ...(clock ? { now: () => clock.now } : {}),
    ...(logger ? { logger } : {}),
  });
  onTestFinished(() => journals.close());
  return journals;
}

function roomFile(dir: string, agentId = AGENT): string {
  return roomJournalFile(agentJournalDir(dir, agentId), ROOM);
}

async function fileRecords(dir: string): Promise<string[]> {
  const text = await readFile(roomFile(dir), "utf8");
  return text.split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { t: string }).t);
}

/** Node's FileHandle prototype: the fs boundary every journal write goes through. */
async function fileHandlePrototype(): Promise<{ appendFile: (...args: unknown[]) => Promise<void> }> {
  const handle = await open(path.join(tmpRoot(), "probe"), "w");
  const prototype = Object.getPrototypeOf(handle) as { appendFile: (...args: unknown[]) => Promise<void> };
  await handle.close();
  return prototype;
}

describe("TurnJournal", () => {
  it("keeps which messages' turns ended across a reopen", async () => {
    const dir = tmpRoot();
    const first = await journalIn(dir).room(ROOM);
    await first.replyBegun("m1");
    await first.turnDone("m1");

    const reopened = await journalIn(dir).room(ROOM);

    expect(reopened.inbound("m1")).toEqual({ done: true, unreportedReplies: 0 });
    expect(reopened.inbound("m2")).toEqual({ done: false, unreportedReplies: 0 });
  });

  it("counts the replies an unfinished turn began until they are reported, once", async () => {
    const dir = tmpRoot();
    const journal = await journalIn(dir).room(ROOM);
    await journal.replyBegun("m1");
    await journal.replyBegun("m1");

    const reopened = await journalIn(dir).room(ROOM);
    expect(reopened.inbound("m1")).toEqual({ done: false, unreportedReplies: 2 });

    await reopened.deliveryUnrecorded("m1");
    await reopened.replyBegun("m1");
    expect((await journalIn(dir).room(ROOM)).inbound("m1")).toEqual({ done: false, unreportedReplies: 1 });
  });

  it("ignores a last record a crash cut short, and appends after it on a line of its own", async () => {
    const dir = tmpRoot();
    const journal = await journalIn(dir).room(ROOM);
    await journal.turnDone("m1");
    await journal.close();
    await appendFile(roomFile(dir), '{"t":"turn.do');

    const reopened = await journalIn(dir).room(ROOM);
    expect(reopened.inbound("m1").done).toBe(true);
    await reopened.turnDone("m2");
    expect(await fileRecords(dir)).toEqual(["turn.done", "turn.done"]);
    expect((await journalIn(dir).room(ROOM)).inbound("m2").done).toBe(true);
  });

  it("drops a line that parses but is not a record, warning, instead of failing the room", async () => {
    const dir = tmpRoot();
    const journal = await journalIn(dir).room(ROOM);
    await journal.turnDone("m1");
    await journal.close();
    await appendFile(roomFile(dir), 'null\n{"t":"turn.done"}\n');
    const { logger, logged } = recordingLogger();

    const reopened = await journalIn(dir, { logger }).room(ROOM);

    expect(reopened.inbound("m1").done).toBe(true);
    expect(await fileRecords(dir)).toEqual(["turn.done"]);
    expect(logged.entries).toEqual([{ level: "warn", message: expect.any(String), context: { unreadable: 2, expired: 0 } }]);
  });

  it("keeps the next record whole after an append the disk cut short", async () => {
    const dir = tmpRoot();
    const journal = await journalIn(dir).room(ROOM);
    const prototype = await fileHandlePrototype();
    const appendLine = prototype.appendFile;
    let cut = false;
    const spy = vi.spyOn(prototype, "appendFile").mockImplementation(async function (this: unknown, ...args: unknown[]) {
      const [data] = args;
      if (!cut && typeof data === "string" && data.includes("message-a")) {
        cut = true;
        // Half the line lands, then the disk is full.
        await appendLine.call(this, data.slice(0, Math.floor(data.length / 2)), "utf8");
        throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
      }
      return appendLine.apply(this, args);
    });
    onTestFinished(() => spy.mockRestore());

    await expect(journal.turnDone("message-a")).rejects.toBeInstanceOf(BandSdkError);
    await journal.turnDone("message-b");
    await journal.close();
    spy.mockRestore();

    const reopened = await journalIn(dir).room(ROOM);
    expect(reopened.inbound("message-b").done).toBe(true);
    expect(reopened.inbound("message-a").done).toBe(false);
  });

  it("reopens a released room only after its close, with every record the closing handle wrote", async () => {
    const journals = journalIn(tmpRoot());
    const released = await journals.room(ROOM);
    await released.turnDone("m1");
    const order: string[] = [];
    const closing = createDeferred();
    const closeRoom = RoomJournal.prototype.close;
    const close = vi.spyOn(RoomJournal.prototype, "close").mockImplementation(async function (this: RoomJournal) {
      await closing.promise;
      await closeRoom.call(this);
      order.push("closed");
    });
    const openRoom = RoomJournal.open.bind(RoomJournal);
    const reopen = vi.spyOn(RoomJournal, "open").mockImplementation((file, options) => {
      order.push("opened");
      return openRoom(file, options);
    });
    onTestFinished(() => {
      close.mockRestore();
      reopen.mockRestore();
    });

    const releasing = journals.release(ROOM);
    const reopened = journals.room(ROOM);
    closing.resolve();
    const journal = await reopened;
    await releasing;

    expect(order).toEqual(["closed", "opened"]);
    await expect(released.turnDone("late")).rejects.toBeInstanceOf(RuntimeStateError);
    expect(journal).not.toBe(released);
    expect(journal.inbound("m1").done).toBe(true);
  });

  it("reopens a room whose close failed", async () => {
    const journals = journalIn(tmpRoot());
    const released = await journals.room(ROOM);
    await released.turnDone("m1");
    const close = vi.spyOn(RoomJournal.prototype, "close").mockRejectedValueOnce(new Error("EIO: i/o error, close"));
    onTestFinished(() => close.mockRestore());

    // The room's next turn reopens it while the failing close is still in flight.
    const releasing = journals.release(ROOM);
    const reopened = journals.room(ROOM);
    await expect(releasing).rejects.toThrow("EIO");
    close.mockRestore();

    expect((await reopened).inbound("m1").done).toBe(true);
    await released.close();
  });

  it("forgets a message one retention after its last record, in memory and on disk", async () => {
    const dir = tmpRoot();
    const clock = { now: 1_000 };
    const journal = await journalIn(dir, { clock }).room(ROOM);
    await journal.turnDone("old");
    // A message expires from its last record, not its first: this one's first is as old as "old".
    await journal.replyBegun("recent");
    clock.now += RETENTION_MS / 2;
    await journal.replyBegun("recent");

    clock.now += RETENTION_MS / 2 + 1;
    expect(journal.inbound("old").done).toBe(false);
    expect(journal.inbound("recent").unreportedReplies).toBe(2);
    await journal.close();

    const { logger, logged } = recordingLogger();
    const reopened = await journalIn(dir, { clock, logger }).room(ROOM);
    expect(await fileRecords(dir)).toEqual(["reply.intent", "reply.intent"]);
    expect(reopened.inbound("recent").unreportedReplies).toBe(2);
    expect(logged.entries).toEqual([{ level: "debug", message: expect.any(String), context: { expired: 1 } }]);
  });

  it("keeps rooms and agents apart", async () => {
    const dir = tmpRoot();
    const journals = journalIn(dir);
    await (await journals.room("room-a")).turnDone("m1");

    expect((await journals.room("room-b")).inbound("m1").done).toBe(false);
    expect(await journals.room("room-a")).toBe(await journals.room("room-a"));
    expect((await journalIn(dir, { agentId: "agent-two" }).room("room-a")).inbound("m1").done).toBe(false);
  });

  it("fails prepare for a journalDir that is not a usable directory", async () => {
    const dir = tmpRoot();
    await appendFile(path.join(dir, "not-a-dir"), "");

    await expect(journalIn(path.join(dir, "not-a-dir")).prepare()).rejects.toBeInstanceOf(ValidationError);
    await expect(journalIn(dir).prepare()).resolves.toBeUndefined();
  });

  it("fails to open a room whose file cannot be read, and opens it once it can be", async () => {
    const dir = tmpRoot();
    await mkdir(roomFile(dir), { recursive: true });
    const journals = journalIn(dir);

    const failed = journals.room(ROOM);
    await expect(failed).rejects.toBeInstanceOf(BandSdkError);
    await expect(failed).rejects.toThrow("Turn journal I/O failed");
    await rm(roomFile(dir), { recursive: true });

    await (await journals.room(ROOM)).turnDone("m1");
    expect((await journals.room(ROOM)).inbound("m1").done).toBe(true);
  });
});
