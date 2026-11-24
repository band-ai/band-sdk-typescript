import { mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createDeferred } from "../src/core/deferred";
import { DeliveryUnknownError } from "../src/core/deliveryFailedError";
import { BandSdkError, ValidationError } from "../src/core/errors";
import { NoopLogger } from "../src/core/logger";
import { JournalFileError, JournalPublicationError } from "../src/runtime/journal/errors";
import { identityDirectoryComponent, roomFileComponent } from "../src/runtime/journal/records";
import { migrateTurnJournals } from "../src/runtime/journal/migration";
import { RoomJournal, roomFileName } from "../src/runtime/journal/RoomJournal";
import { TurnJournal, agentJournalDir, type JournalGeneration } from "../src/runtime/journal/TurnJournal";
import { PublicationEngine } from "../src/runtime/journal/publication";
import { JournalOwnershipError } from "../src/runtime/journal/ownership";
import { tmpRoot } from "./testUtils";
import {
  AGENT,
  IDENTITY,
  OTHER_IDENTITY,
  ROOM,
  diskFull,
  flushMicrotasks,
  generationIn,
  holdJournalAppend,
  holdJournalRewrite,
  interceptJournalAppends,
  journalLines,
  recordTypes,
  roomFile,
  seedLegacyFile,
  writeRawFile,
  legacyRoomFile,
} from "./turnJournalSupport";

/** The v2 file's header line, bound to `identity`, `agentId` and `ROOM`. */
function header(identity: string, agentId = AGENT, roomId = ROOM): string {
  return `${JSON.stringify({ t: "header", v: 2, platformIdentity: identity, agentId, roomId, at: 1 })}\n`;
}

const roomOptions = { platformIdentity: IDENTITY, agentId: AGENT, roomId: ROOM } as const;

describe("the v2 journal's file layout", () => {
  it("binds each room's file to its identity's directory and header", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const room = await generation.room(ROOM);
    await room.turnDone("msg-1");

    const file = roomFile(dir);
    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    expect(path.dirname(file)).toBe(path.join(agentJournalDir(dir, AGENT), identityDirectoryComponent(IDENTITY)));
    expect(JSON.parse(lines[0])).toMatchObject({ t: "header", v: 2, platformIdentity: IDENTITY, agentId: AGENT });
    expect(JSON.parse(lines[1])).toMatchObject({ t: "turn.done", messageId: "msg-1" });
  });

  it("keeps rooms, agents, and identities apart", async () => {
    const dir = tmpRoot();
    const journals = new TurnJournal(dir, AGENT);
    const first = await journals.activate(IDENTITY);
    await first.room("room-a");
    await first.room("room/b");
    await first.close();

    const second = await journals.activate(OTHER_IDENTITY);
    await second.room(ROOM);
    await second.close();

    const otherAgent = await new TurnJournal(dir, "agent/two").activate(IDENTITY);
    await otherAgent.room(ROOM);
    await otherAgent.close();

    const entries = new Set((await readdir(agentJournalDir(dir, AGENT), { withFileTypes: true })).map((entry) => entry.name));
    expect(entries).toContain(identityDirectoryComponent(IDENTITY));
    expect(entries).toContain(identityDirectoryComponent(OTHER_IDENTITY));
    expect((await readdir(path.join(agentJournalDir(dir, "agent/two"), identityDirectoryComponent(IDENTITY)))).join(", ")).toBe(roomFileName(ROOM));
  });

  it("fails to activate over a journalDir that is not a usable directory", async () => {
    const dir = tmpRoot();
    const file = path.join(dir, "journal");
    await writeFile(file, "not a directory");
    await expect(new TurnJournal(file, AGENT).prepare()).rejects.toBeInstanceOf(BandSdkError);
  });
});

describe("strict validation refuses, and never resets", () => {
  it("refuses a file whose header names another identity than its directory", async () => {
    const dir = tmpRoot();
    // A file in OTHER's directory claiming to belong to IDENTITY: forged or moved, and refused.
    await writeRawFile(dir, OTHER_IDENTITY, [header(IDENTITY)]);
    const file = roomFile(dir, OTHER_IDENTITY);
    await expect(RoomJournal.open(file, { platformIdentity: OTHER_IDENTITY, agentId: AGENT, roomId: ROOM }))
      .rejects.toBeInstanceOf(JournalFileError);
    expect(await readFile(file, "utf8")).toBe(header(IDENTITY));
  });

  it("refuses a v1 header or a record it does not know, leaving the file untouched", async () => {
    const legacy = `${JSON.stringify({ t: "v1-legacy", messageId: "m", at: 1 })}\n`;
    const dir = tmpRoot();
    const before = await writeRawFile(dir, IDENTITY, [header(IDENTITY), legacy]);
    await expect(RoomJournal.open(roomFile(dir), roomOptions)).rejects.toBeInstanceOf(JournalFileError);
    expect(await readFile(before, "utf8")).toBe(header(IDENTITY) + legacy);

    const dir2 = tmpRoot();
    const unknown = `${JSON.stringify({ t: "reply.intent", messageId: "m", publicationId: "p", at: 1, extra: true })}\n`;
    const before2 = await writeRawFile(dir2, IDENTITY, [header(IDENTITY), unknown]);
    await expect(RoomJournal.open(roomFile(dir2), roomOptions)).rejects.toBeInstanceOf(JournalFileError);
    expect(await readFile(before2, "utf8")).toBe(header(IDENTITY) + unknown);
  });

  it.each([
    ["a second intent for the same publication", [`${JSON.stringify({ t: "reply.intent", messageId: "m", publicationId: "p", at: 1 })}\n`, `${JSON.stringify({ t: "reply.intent", messageId: "m", publicationId: "p", at: 2 })}\n`]],
    ["a settlement for a publication never admitted", [`${JSON.stringify({ t: "reply.settled", messageId: "m", publicationId: "p", at: 1 })}\n`]],
    ["a second terminal for one publication", [`${JSON.stringify({ t: "reply.intent", messageId: "m", publicationId: "p", at: 1 })}\n`, `${JSON.stringify({ t: "reply.settled", messageId: "m", publicationId: "p", at: 2 })}\n`, `${JSON.stringify({ t: "reply.refused", messageId: "m", publicationId: "p", at: 3 })}\n`]],
  ])("refuses a file with %s", async (_case, records) => {
    const dir = tmpRoot();
    await writeRawFile(dir, IDENTITY, [header(IDENTITY), ...records]);
    await expect(RoomJournal.open(roomFile(dir), roomOptions)).rejects.toBeInstanceOf(JournalFileError);
  });

  it("fails to open a room whose file is unreadable, as an I/O failure", async () => {
    const dir = tmpRoot();
    // The journal's path is occupied by a directory: its file cannot be read.
    await mkdir(roomFile(dir), { recursive: true });
    onTestFinished(() => rm(roomFile(dir), { recursive: true, force: true }));
    await expect(RoomJournal.open(roomFile(dir), roomOptions)).rejects.toMatchObject({ kind: "io" });
  });
});

describe("a journal's room binding", () => {
  it("refuses a file whose header binds another room than its file name stands for", async () => {
    const other = "room/other";
    const dir = tmpRoot();
    // Room A's journal, byte for byte, under room B's file name: a copy of another room's authority.
    const file = roomFile(dir, IDENTITY, AGENT, other);
    await mkdir(path.dirname(file), { recursive: true });
    const copied = `${header(IDENTITY)}${JSON.stringify({ t: "turn.done", messageId: "m", at: 1 })}\n`;
    await writeFile(file, copied);
    await expect(RoomJournal.open(file, { platformIdentity: IDENTITY, agentId: AGENT, roomId: other }))
      .rejects.toBeInstanceOf(JournalFileError);
    // The copy stands untouched: nothing was rewritten into a journal it is not.
    expect(await readFile(file, "utf8")).toBe(copied);

    // And the mirror image: room A's file name, a header binding room B.
    const dir2 = tmpRoot();
    const file2 = roomFile(dir2);
    await mkdir(path.dirname(file2), { recursive: true });
    await writeFile(file2, header(IDENTITY, AGENT, other));
    await expect(RoomJournal.open(file2, roomOptions)).rejects.toBeInstanceOf(JournalFileError);
  });

  it("keeps agent, room, and identity names out of paths, whatever they contain", async () => {
    const dir = tmpRoot();
    const root = path.resolve(dir);
    for (const roomId of ["..", "../escape", ".", "a/b"]) {
      const file = roomFile(dir, IDENTITY, AGENT, roomId);
      expect(file.startsWith(root)).toBe(true);
      expect(/^[0-9a-f]{64}\.jsonl$/.test(path.basename(file))).toBe(true);
    }
    for (const agentId of ["..", "../escape", "."]) {
      const agentDir = agentJournalDir(dir, agentId);
      expect(agentDir.startsWith(root)).toBe(true);
      expect(/^[0-9a-f]{64}$/.test(path.basename(agentDir))).toBe(true);
    }
    // Distinct ids stand for distinct names.
    expect(roomFileComponent("..")).not.toBe(roomFileComponent("..x"));
    expect(roomFileComponent("a/b")).not.toBe(roomFileComponent("a" + String.fromCharCode(0) + "b"));
  });
});

describe("a torn tail", () => {
  it("keeps a tail that is itself a whole record, and drops the rest of a torn line", async () => {
    const dir = tmpRoot();
    const intent = `${JSON.stringify({ t: "reply.intent", messageId: "m", publicationId: "p", at: 1 })}`;
    const settled = `${JSON.stringify({ t: "reply.settled", messageId: "m", publicationId: "p", at: 2 })}`;
    // A crash after writing the settled record but before its newline: it stands.
    await writeRawFile(dir, IDENTITY, [header(IDENTITY), `${intent}\n`, settled]);
    const whole = await RoomJournal.open(roomFile(dir), roomOptions);
    onTestFinished(() => whole.close());
    expect(whole.answered("m")).toBe(true);
    const rewritten = (await readFile(roomFile(dir), "utf8")).split("\n").filter(Boolean);
    expect(JSON.parse(rewritten[1]).t).toBe("reply.intent");
    expect(JSON.parse(rewritten[2]).t).toBe("reply.settled");

    // A crash mid-record: the torn tail is dropped, the prefix stands.
    const dir2 = tmpRoot();
    await writeRawFile(dir2, IDENTITY, [header(IDENTITY), `${intent}\n`, `${settled.slice(0, 20)}`]);
    const torn = await RoomJournal.open(roomFile(dir2), roomOptions);
    onTestFinished(() => torn.close());
    expect(torn.answered("m")).toBe(false);
    const lines = (await readFile(roomFile(dir2), "utf8")).split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]).t).toBe("reply.intent");
  });

  it("starts the next append on a line of its own after a torn tail", async () => {
    const dir = tmpRoot();
    await writeRawFile(dir, IDENTITY, [header(IDENTITY), `${JSON.stringify({ t: "turn.done", messageId: "a", at: 1 })}\n`, `{"t":"turn.d`]);
    const journal = await RoomJournal.open(roomFile(dir), roomOptions);
    onTestFinished(() => journal.close());
    await journal.turnDone("b");
    const lines = (await readFile(roomFile(dir), "utf8")).split("\n").filter(Boolean);
    expect(JSON.parse(lines[1]).t).toBe("turn.done");
    expect(JSON.parse(lines[2])).toMatchObject({ t: "turn.done", messageId: "b" });
  });
});

describe("the non-expiring authority", () => {
  it("keeps an old answered inbound answered again never, across generations", async () => {
    const dir = tmpRoot();
    const first = await new TurnJournal(dir, AGENT).activate(IDENTITY);
    const room = await first.room(ROOM);
    await room.turnDone("msg-1");
    await first.close();

    const second = await new TurnJournal(dir, AGENT).activate(IDENTITY);
    const reopened = await second.room(ROOM);
    expect(reopened.answered("msg-1")).toBe(true);
    expect(await recordTypes(roomFile(dir))).toEqual(["turn.done"]);
    await second.close();
  });
});

describe("publications", () => {
  it("writes the intent durably before the post runs, and settles before the result returns", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const room = await generation.room(ROOM);
    const engine = PublicationEngine.create({
      roomId: ROOM,
      generation,
      logger: new NoopLogger(),
    });
    const intentEntered = createDeferred();
    const releaseIntent = createDeferred();
    const settleEntered = createDeferred();
    const releaseSettle = createDeferred();
    onTestFinished(() => {
      releaseIntent.resolve();
      releaseSettle.resolve();
    });
    let holdingIntent = false;
    let holdingSettle = false;
    await interceptJournalAppends(async (original, self, args) => {
      const line = typeof args[0] === "string" ? args[0] : "";
      if (!holdingIntent && line.includes('"t":"reply.intent"')) {
        holdingIntent = true;
        intentEntered.resolve();
        await releaseIntent.promise;
      } else if (!holdingSettle && line.includes('"t":"reply.settled"')) {
        holdingSettle = true;
        settleEntered.resolve();
        await releaseSettle.promise;
      }
      return original.apply(self, args);
    });
    const posted = { ran: false };
    const publish = engine.publishReply("msg-1", async () => {
      posted.ran = true;
      return { success: true, message: { id: "posted-1" } };
    });
    await intentEntered.promise;
    // The intent is not on disk yet: the post that waits on it has not run.
    expect(posted.ran).toBe(false);
    releaseIntent.resolve();
    await settleEntered.promise;
    expect(posted.ran).toBe(true);
    // Settlement is not durable yet: publishReply must stay pending.
    let returned = false;
    void publish.then(() => {
      returned = true;
    });
    await Promise.resolve();
    expect(returned).toBe(false);
    releaseSettle.resolve();
    await publish;
    expect(returned).toBe(true);
    expect(await recordTypes(roomFile(dir))).toEqual(["reply.intent", "reply.settled"]);
    expect(room.answered("msg-1")).toBe(true);
  });

  it("records a top-level post id as the receipt, with nested message.id as fallback", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const engine = PublicationEngine.create({
      roomId: ROOM,
      generation,
      logger: new NoopLogger(),
    });
    // FernRestAdapter createChatMessage exposes top-level `id`, not nested message.id.
    await engine.publishReply("msg-top", async () => ({ success: true, id: "posted-top" }));
    await engine.publishReply("msg-nested", async () => ({ success: true, message: { id: "posted-nested" } }));
    const settled = (await journalLines(roomFile(dir))).filter((line) => line.t === "reply.settled");
    expect(settled).toEqual([
      expect.objectContaining({ messageId: "msg-top", receiptId: "posted-top" }),
      expect.objectContaining({ messageId: "msg-nested", receiptId: "posted-nested" }),
    ]);
  });

  it("records a cut-short refusal durably when the refuse append fails, so reopen does not announce pending", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const room = await generation.room(ROOM);
    const engine = PublicationEngine.create({
      roomId: ROOM,
      generation,
      logger: new NoopLogger(),
    });
    const controller = new AbortController();
    await interceptJournalAppends(async (original, self, args) => {
      const line = typeof args[0] === "string" ? args[0] : "";
      if (line.includes("reply.intent")) {
        const result = await original.apply(self, args);
        controller.abort("interrupt");
        return result;
      }
      if (line.includes("reply.refused")) return Promise.reject(diskFull());
      return original.apply(self, args);
    });

    await expect(
      engine.publishReply("msg-cut", async () => ({ success: true, id: "must-not-post" }), controller.signal),
    ).rejects.toBeInstanceOf(BandSdkError);
    // Refuse append failed; rewrite still left a durable refusal — not a recoverable pending.
    expect(await recordTypes(roomFile(dir))).toEqual(["reply.intent", "reply.refused"]);
    expect(await room.recoverUnresolved()).toEqual([]);

    await generation.close();
    const second = await new TurnJournal(dir, AGENT).activate(IDENTITY);
    onTestFinished(() => second.close());
    const reopened = await second.room(ROOM);
    expect(await reopened.recoverUnresolved()).toEqual([]);
    expect(await recordTypes(roomFile(dir))).toEqual(["reply.intent", "reply.refused"]);
  });

  it("keeps poison from A's failed settle when B's refuse rewrite lands", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const room = await generation.room(ROOM);
    const pubA = await room.beginReply("msg-A");
    const pubB = await room.beginReply("msg-B");

    await interceptJournalAppends(async (original, self, args) => {
      const line = typeof args[0] === "string" ? args[0] : "";
      if (line.includes("reply.settled")) return Promise.reject(diskFull());
      if (line.includes("reply.refused")) return Promise.reject(diskFull());
      return original.apply(self, args);
    });

    await expect(room.settleReply("msg-A", pubA, "receipt-A")).rejects.toBeTruthy();
    expect(room.accepting).toBe(false);

    await room.markRefused("msg-B", pubB);
    // B's refuse landed via rewrite; A's owed settlement debt must keep the writer closed.
    expect(room.accepting).toBe(false);
    expect(await recordTypes(roomFile(dir))).toEqual(["reply.intent", "reply.intent", "reply.refused"]);
    await expect(room.beginReply("msg-C")).rejects.toMatchObject({ kind: "poisoned" });
  });

  it("surfaces cut-short markRefused rewrite failure instead of leaving only a cut error and reopen pending", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const room = await generation.room(ROOM);
    const engine = PublicationEngine.create({
      roomId: ROOM,
      generation,
      logger: new NoopLogger(),
    });
    const controller = new AbortController();

    await interceptJournalAppends(async (original, self, args) => {
      const line = typeof args[0] === "string" ? args[0] : "";
      if (line.includes("reply.intent")) {
        const result = await original.apply(self, args);
        controller.abort("interrupt");
        return result;
      }
      if (line.includes("reply.refused")) return Promise.reject(diskFull());
      return original.apply(self, args);
    });

    // Fail FileHandle.writeFile used by rewriteFile's compacting copy.
    const probe = await open(path.join(dir, "probe-write"), "w");
    const prototype = Object.getPrototypeOf(probe) as { writeFile: (...args: unknown[]) => Promise<void> };
    await probe.close();
    const writeSpy = vi.spyOn(prototype, "writeFile").mockImplementation(() => Promise.reject(diskFull()));
    onTestFinished(() => writeSpy.mockRestore());

    const error: unknown = await engine
      .publishReply("msg-cut", async () => ({ success: true, id: "must-not-post" }), controller.signal)
      .catch((thrown: unknown) => thrown);

    expect(room.accepting).toBe(false);
    // Refuse I/O failure must surface — not only the cut-short error.
    expect(error).toBeInstanceOf(JournalFileError);
    expect(String(error).includes("cut short")).toBe(false);

    await generation.close();
    const second = await new TurnJournal(dir, AGENT).activate(IDENTITY);
    onTestFinished(() => second.close());
    const reopened = await second.room(ROOM);
    // The refusal never landed: the reopened journal reports the intent rather than hide it.
    expect(await reopened.recoverUnresolved()).toEqual([expect.objectContaining({ messageId: "msg-cut", outcome: "pending" })]);
  });

  it("keeps another reply's owed settlement poison when a refusal queued behind it lands", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const engine = PublicationEngine.create({ roomId: ROOM, generation, logger: new NoopLogger() });
    const settleEntered = createDeferred();
    const failSettle = createDeferred();
    await interceptJournalAppends(async (original, self, args) => {
      if (typeof args[0] === "string" && args[0].includes("reply.settled")) {
        settleEntered.resolve();
        await failSettle.promise;
        throw diskFull();
      }
      return original.apply(self, args);
    });

    // Two parallel replies: A is accepted and its settlement's write held; B is refused meanwhile.
    const bRefused = createDeferred();
    const refusedB = new ValidationError("mention cannot be resolved");
    const replyA = engine.publishReply("msg-A", async () => ({ success: true, id: "post-A" }));
    const replyB = engine.publishReply("msg-B", async () => {
      await bRefused.promise;
      throw refusedB;
    });
    await settleEntered.promise;
    bRefused.resolve();
    // B's refusal queues behind A's settlement, which the disk then fails.
    await flushMicrotasks();
    failSettle.resolve();

    await expect(replyA).rejects.toBeInstanceOf(DeliveryUnknownError);
    await expect(replyB).rejects.toBe(refusedB);
    const room = await generation.room(ROOM);
    // A's acknowledged reply could not be settled: the writer admits nothing until it reopens.
    expect(room.accepting).toBe(false);
    expect(await recordTypes(roomFile(dir))).toEqual(["reply.intent", "reply.intent", "reply.refused"]);
    await expect(room.beginReply("msg-C")).rejects.toMatchObject({ kind: "poisoned" });
  });

  it("syncs a refusal whose append reached the file but whose sync failed, recording it once", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const room = await generation.room(ROOM);
    const publicationId = await room.beginReply("msg-1");

    // The refusal's line reaches the file, and its sync fails, as a failing disk does.
    let refuseAppended = false;
    await interceptJournalAppends(async (original, self, args) => {
      if (typeof args[0] === "string" && args[0].includes("reply.refused")) refuseAppended = true;
      return original.apply(self, args);
    });
    const probe = await open(path.join(dir, "probe-sync"), "w");
    const prototype = Object.getPrototypeOf(probe) as { datasync: () => Promise<void> };
    await probe.close();
    const datasync = prototype.datasync;
    let failedRefuseSync = false;
    let syncedAfterFailure = false;
    const spy = vi.spyOn(prototype, "datasync").mockImplementation(function (this: unknown) {
      if (refuseAppended && !failedRefuseSync) {
        failedRefuseSync = true;
        return Promise.reject(Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" }));
      }
      if (failedRefuseSync) syncedAfterFailure = true;
      return datasync.call(this);
    });
    onTestFinished(() => spy.mockRestore());

    await room.markRefused("msg-1", publicationId);

    expect(failedRefuseSync).toBe(true);
    // The refusal it reports durable was synced after the failed one.
    expect(syncedAfterFailure).toBe(true);
    // The writer lost a write: it stays poisoned until it reopens.
    expect(room.accepting).toBe(false);
    await generation.close();
    const second = await new TurnJournal(dir, AGENT).activate(IDENTITY);
    onTestFinished(() => second.close());
    expect(await (await second.room(ROOM)).recoverUnresolved()).toEqual([]);
    expect(await recordTypes(roomFile(dir))).toEqual(["reply.intent", "reply.refused"]);
  });

  it("stays poisoned when an intent append fails after part of it reached the file", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const room = await generation.room(ROOM);
    await interceptJournalAppends(async (original, self, args) => {
      const line = typeof args[0] === "string" ? args[0] : "";
      if (line.includes("reply.intent")) {
        // A full disk takes half the line, then the append rejects.
        const handle = self as unknown as { write: (buffer: Buffer) => Promise<unknown> };
        await handle.write(Buffer.from(line.slice(0, Math.floor(line.length / 2)), "utf8"));
        throw diskFull();
      }
      return original.apply(self, args);
    });

    await expect(room.beginReply("msg-1")).rejects.toBeInstanceOf(JournalFileError);
    expect(room.accepting).toBe(false);
    await expect(room.beginReply("msg-2")).rejects.toMatchObject({ kind: "poisoned" });
  });

  it("refuses a beginReply queued behind a write once the journal is poisoned (F1)", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const room = await generation.room(ROOM);
    const append = await holdJournalAppend((line) => line.includes('"t":"reply.intent"'));
    const beginA = room.beginReply("msg-1");
    await append.entered;
    // B passed the outer admit check and queues on the Serializer behind A's held write.
    const beginB = room.beginReply("msg-2");
    room.poison();
    append.release();
    await expect(beginA).resolves.toEqual(expect.any(String));
    await expect(beginB).rejects.toMatchObject({ kind: "poisoned" });
    expect(await recordTypes(roomFile(dir))).toEqual(["reply.intent"]);
  });

  it("refuses a queued beginReply after a mid-write poison so a torn settle cannot sit under a later intent (F2)", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const room = await generation.room(ROOM);
    const publicationId = await room.beginReply("msg-1");

    const settleEntered = createDeferred();
    const releaseSettle = createDeferred();
    await interceptJournalAppends(async (original, self, args) => {
      const line = typeof args[0] === "string" ? args[0] : "";
      if (line.includes("reply.settled")) {
        settleEntered.resolve();
        await releaseSettle.promise;
        const handle = self as unknown as { write: (buffer: Buffer) => Promise<unknown> };
        await handle.write(Buffer.from(line.slice(0, Math.floor(line.length / 2)), "utf8"));
        throw diskFull();
      }
      return original.apply(self, args);
    });

    const settle = room.settleReply("msg-1", publicationId, "posted-1");
    await settleEntered.promise;
    // B passed the outer admit check while settle is mid-write, then queues.
    const beginB = room.beginReply("msg-2");
    releaseSettle.resolve();
    await expect(settle).rejects.toBeInstanceOf(JournalFileError);
    await expect(beginB).rejects.toMatchObject({ kind: "poisoned" });
    expect(room.accepting).toBe(false);

    const text = await readFile(roomFile(dir), "utf8");
    // Intent, then a torn settle fragment — no second intent after the tear.
    expect(text).not.toContain('"messageId":"msg-2"');
    const lines = text.split("\n");
    expect(JSON.parse(lines[1])).toMatchObject({ t: "reply.intent", messageId: "msg-1" });
    expect(() => JSON.parse(lines[lines.length - 1] || "")).toThrow();

    await generation.close();
    const reopened = await new TurnJournal(dir, AGENT).activate(IDENTITY);
    onTestFinished(() => reopened.close());
    const journal = await reopened.room(ROOM);
    expect(journal.accepting).toBe(true);
    expect(await recordTypes(roomFile(dir))).toEqual(["reply.intent"]);
  });

  it("closes a released room's handle only once a reply admitted before the release settles on it", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const room = await generation.room(ROOM);
    const engine = PublicationEngine.create({ roomId: ROOM, generation, logger: new NoopLogger() });
    const append = await holdJournalAppend((line) => line.includes('"t":"reply.intent"'));
    const publish = engine.publishReply("msg-1", async () => ({ success: true, message: { id: "posted-1" } }));
    await append.entered;
    // The room is left while the reply's durable intent is still being written.
    generation.release(ROOM);
    expect(room.isClosed).toBe(false);
    append.release();
    await expect(publish).resolves.toMatchObject({ success: true });
    expect(room.isClosed).toBe(true);
    expect(await recordTypes(roomFile(dir))).toEqual(["reply.intent", "reply.settled"]);
  });

  it("keeps the journal owned while a reply's room journal is still opening, and the reply settles durably", async () => {
    const dir = tmpRoot();
    const { journals, generation } = await generationIn(dir);
    const engine = PublicationEngine.create({ roomId: ROOM, generation, logger: new NoopLogger() });
    const rewrite = await holdJournalRewrite();
    const publish = engine.publishReply("msg-1", async () => ({ success: true, message: { id: "posted-1" } }));
    await rewrite.entered;
    // The runtime stops while the reply's journal is still opening: the stop waits for the reply.
    const closing = generation.close();
    await flushMicrotasks();
    await expect(journals.activate(IDENTITY)).rejects.toBeInstanceOf(JournalOwnershipError);
    rewrite.release();
    await expect(publish).resolves.toMatchObject({ success: true });
    await closing;
    expect(await recordTypes(roomFile(dir))).toEqual(["reply.intent", "reply.settled"]);
  });

  it("keeps a refused reply's inbound unanswered, and it is not announced", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const room = await generation.room(ROOM);
    const publicationId = await room.beginReply("msg-1");
    await room.markRefused("msg-1", publicationId);
    expect(room.answered("msg-1")).toBe(false);
    expect(await room.recoverUnresolved()).toEqual([]);
    await generation.close();

    const second = await new TurnJournal(dir, AGENT).activate(IDENTITY);
    const reopened = await second.room(ROOM);
    expect(await reopened.recoverUnresolved()).toEqual([]);
    expect(await recordTypes(roomFile(dir))).toEqual(["reply.intent", "reply.refused"]);
    await second.close();
  });

  it("announces an unknown publication on the same handle, then never again after reopen", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const room = await generation.room(ROOM);
    const publicationId = await room.beginReply("msg-1");
    await room.markUnknown("msg-1", publicationId);
    // Same-handle recover must still return the unknown so stop/play can emit delivery.unrecorded.
    expect(await room.recoverUnresolved()).toEqual([
      { messageId: "msg-1", publicationId, outcome: "unknown", at: expect.any(Number) },
    ]);
    expect(await room.recoverUnresolved()).toEqual([]);
    expect(await recordTypes(roomFile(dir))).toEqual(["reply.intent", "reply.unknown", "publication.reported"]);
    await generation.close();

    const second = await new TurnJournal(dir, AGENT).activate(IDENTITY);
    const reopened = await second.room(ROOM);
    expect(await reopened.recoverUnresolved()).toEqual([]);
    expect(await recordTypes(roomFile(dir))).toEqual(["reply.intent", "reply.unknown", "publication.reported"]);
    await second.close();
  });

  it("settles a decline durably before it counts as declined", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const room = await generation.room(ROOM);
    await room.settleDecline("msg-1");
    expect(room.answered("msg-1")).toBe(true);
    expect(await recordTypes(roomFile(dir))).toEqual(["decline.settled"]);
  });

  it("refuses new publications once poisoned, until the handle reopens", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const room = await generation.room(ROOM);
    room.poison();
    expect(room.accepting).toBe(false);
    await expect(room.beginReply("msg-1")).rejects.toMatchObject({ kind: "poisoned" });
    await expect(room.turnDone("msg-1")).rejects.toBeInstanceOf(JournalPublicationError);

    await generation.close();
    const second = await new TurnJournal(dir, AGENT).activate(IDENTITY);
    const reopened = await second.room(ROOM);
    expect(reopened.accepting).toBe(true);
    await second.close();
  });

  it("refuses a write to a closed handle; a closed generation's rooms reject", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const room = await generation.room(ROOM);
    await room.close();
    expect(room.accepting).toBe(false);
    await expect(room.beginReply("msg-1")).rejects.toMatchObject({ kind: "closed" });
    await expect(room.turnDone("msg-1")).rejects.toMatchObject({ kind: "closed" });
    // The generation hands back the closed handle: nothing it writes is admitted.
    const again = await generation.room(ROOM);
    expect(again.accepting).toBe(false);
    await generation.close();
    await expect(generation.room(ROOM)).rejects.toBeInstanceOf(BandSdkError);
  });

  it("keeps the durable intent when a disk will not take the settlement, and the writer stops admitting", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const room = await generation.room(ROOM);
    const publicationId = await room.beginReply("msg-1");
    await interceptJournalAppends(async (original, self, args) =>
      typeof args[0] === "string" && args[0].includes("reply.settled") ? Promise.reject(diskFull()) : original.apply(self, args));

    await expect(room.settleReply("msg-1", publicationId, "posted-1")).rejects.toBeInstanceOf(JournalFileError);
    // The intent stands on disk; the settlement does not. The write that failed may have
    // left the file torn, so the writer that lost the write it owes stops admitting:
    // no later append may stand beneath an uncertain write.
    expect(room.accepting).toBe(false);
    await expect(room.markUnknown("msg-1", publicationId)).rejects.toMatchObject({ kind: "poisoned" });
    expect(await recordTypes(roomFile(dir))).toEqual(["reply.intent"]);
  });

  it("poisons the writer when an append fails mid-write, and recovers the torn tail on reopen", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const room = await generation.room(ROOM);
    const publicationId = await room.beginReply("msg-1");
    // A write that fails halfway: the file holds part of the settled line, so it no
    // longer stands as the writer read it.
    await interceptJournalAppends(async (original, self, args) => {
      const line = typeof args[0] === "string" ? args[0] : "";
      if (line.includes("reply.settled")) {
        const handle = self as unknown as { write: (buffer: Buffer) => Promise<unknown> };
        await handle.write(Buffer.from(line.slice(0, Math.floor(line.length / 2)), "utf8"));
        throw diskFull();
      }
      return original.apply(self, args);
    });

    await expect(room.settleReply("msg-1", publicationId, "posted-1")).rejects.toBeInstanceOf(JournalFileError);
    // The torn line stands on disk; a later record must not stand beneath it.
    const tornFile = (await readFile(roomFile(dir), "utf8")).split("\n");
    expect(tornFile[tornFile.length - 1].length).toBeGreaterThan(0);
    expect(() => JSON.parse(tornFile[tornFile.length - 1])).toThrow();
    expect(room.accepting).toBe(false);
    await expect(room.markUnknown("msg-1", publicationId)).rejects.toMatchObject({ kind: "poisoned" });
    await expect(room.turnDone("msg-1")).rejects.toBeInstanceOf(JournalPublicationError);

    // On reopen the torn tail is dropped, the prefix stands, and the writer is fresh.
    await generation.close();
    const reopened = await new TurnJournal(dir, AGENT).activate(IDENTITY);
    onTestFinished(() => reopened.close());
    const journal = await reopened.room(ROOM);
    expect(journal.accepting).toBe(true);
    expect(await recordTypes(roomFile(dir))).toEqual(["reply.intent"]);
    // The intent that stands is unresolved: the torn settlement is neither there nor trusted.
    expect(journal.answered("msg-1")).toBe(false);
  });
});

describe("ownership and generations", () => {
  it("lets one generation own the agent's journal at a time", async () => {
    const dir = tmpRoot();
    const first = await new TurnJournal(dir, AGENT).activate(IDENTITY);
    const contested = new TurnJournal(dir, AGENT).activate(IDENTITY);
    await expect(contested).rejects.toBeInstanceOf(JournalOwnershipError);
    await first.close();
    const second = await new TurnJournal(dir, AGENT).activate(IDENTITY);
    await second.close();
  });

  it("lets a start over a committed migration run, and refuses one over unbound legacy files", async () => {
    const dir = tmpRoot();
    const source = await seedLegacyFile(dir, AGENT, legacyRoomFile(ROOM), [JSON.stringify({ t: "turn.done", messageId: "m", at: 1 })]);
    await expect(new TurnJournal(dir, AGENT).activate(IDENTITY)).rejects.toMatchObject({ kind: "unbound-legacy" });

    // The operator binds the legacy file offline; the start then runs over what it staged.
    const sourceSha256 = createHash("sha256").update(await readFile(source)).digest("hex");
    const result = await migrateTurnJournals({
      journalDir: dir,
      agentId: AGENT,
      apply: true,
      bindings: [{ sourceFile: legacyRoomFile(ROOM), roomId: ROOM, sourceSha256, platformIdentity: IDENTITY, provenance: "operator-attested" }],
    });
    expect(result.mode).toBe("committed");

    const generation = await new TurnJournal(dir, AGENT).activate(IDENTITY);
    const room = await generation.room(ROOM);
    expect(room.answered("m")).toBe(true);
    await generation.close();
  });

  it("resumes a migration a crash left prepared, instead of initializing empty", async () => {
    const dir = tmpRoot();
    const otherAgent = "agent/two";
    const source = await seedLegacyFile(dir, otherAgent, legacyRoomFile(ROOM), [JSON.stringify({ t: "turn.done", messageId: "old", at: 1 })]);
    const sourceSha256 = createHash("sha256").update(await readFile(source)).digest("hex");
    const manifestDir = path.join(agentJournalDir(dir, otherAgent), "migration");
    await mkdir(manifestDir, { recursive: true });
    await writeFile(
      path.join(manifestDir, "manifest.json"),
      `${JSON.stringify({ v: 2, state: "prepared", createdAt: 1, bindings: [{ sourceFile: legacyRoomFile(ROOM), roomId: ROOM, sourceSha256, platformIdentity: IDENTITY, provenance: "crash", stagesFrom: legacyRoomFile(ROOM), stagingSha256: sourceSha256, importedFacts: { publicationIds: [], turnDone: ["old"] } }] }, null, 2)}\n`,
    );

    const generation = await new TurnJournal(dir, otherAgent).activate(IDENTITY);
    const reopened = await generation.room(ROOM);
    expect(reopened.answered("old")).toBe(true);
    const state = JSON.parse(await readFile(path.join(manifestDir, "manifest.json"), "utf8"));
    expect(state.state).toBe("committed");
    await generation.close();
  });

  it("activates over a prepared migration whose destination fails validate, restaging the surplus", async () => {
    // Missing-dest resume is covered above; this is the start path for a
    // prepared-but-invalid destination (amend crash: journal-only staged file
    // vs surplus facts already in the prepared manifest).
    const dir = tmpRoot();
    const v1File = legacyRoomFile(ROOM);
    const remnantFile = `${v1File}.${randomUUID()}.compacting`;
    const legacy = [JSON.stringify({ t: "turn.done", messageId: "b", at: 2 })];
    const source = await seedLegacyFile(dir, AGENT, v1File, legacy);
    const sourceText = await readFile(source, "utf8");
    const sourceSha256 = createHash("sha256").update(sourceText, "utf8").digest("hex");
    const copyOnly = JSON.stringify({ t: "turn.done", messageId: "only-in-copy", at: 3 });
    const copyText = `${legacy.join("\n")}\n${copyOnly}\n`;
    await writeFile(path.join(path.dirname(source), remnantFile), copyText);
    const stagingText = `${sourceText.endsWith("\n") ? sourceText : `${sourceText}\n`}${copyOnly}\n`;
    const stagingSha256 = createHash("sha256").update(stagingText, "utf8").digest("hex");
    const provenance = `operator-attested:${v1File}`;
    const agentDir = agentJournalDir(dir, AGENT);
    const manifestDir = path.join(agentDir, "migration");
    await mkdir(manifestDir, { recursive: true });
    await writeFile(
      path.join(manifestDir, "manifest.json"),
      `${JSON.stringify({
        v: 2,
        state: "prepared",
        createdAt: 1,
        bindings: [
          {
            sourceFile: v1File,
            roomId: ROOM,
            sourceSha256,
            platformIdentity: IDENTITY,
            provenance,
            stagesFrom: v1File,
            stagingSha256,
            importedFacts: { publicationIds: [], turnDone: ["b", "only-in-copy"] },
          },
          {
            sourceFile: remnantFile,
            roomId: ROOM,
            sourceSha256: createHash("sha256").update(copyText, "utf8").digest("hex"),
            platformIdentity: IDENTITY,
            provenance,
            stagesFrom: v1File,
            stagingSha256,
            importedFacts: { publicationIds: [], turnDone: ["b", "only-in-copy"] },
          },
        ],
      }, null, 2)}\n`,
    );
    // Journal-only destination: fails validate against surplus importedFacts.
    const staged = roomFile(dir);
    await mkdir(path.dirname(staged), { recursive: true });
    await writeFile(
      staged,
      `${JSON.stringify({ t: "header", v: 2, platformIdentity: IDENTITY, agentId: AGENT, roomId: ROOM, at: 1 })}\n${JSON.stringify({ t: "turn.done", messageId: "b", at: 2 })}\n`,
    );

    const generation = await new TurnJournal(dir, AGENT).activate(IDENTITY);
    const room = await generation.room(ROOM);
    expect(room.answered("b")).toBe(true);
    expect(room.answered("only-in-copy")).toBe(true);
    const state = JSON.parse(await readFile(path.join(manifestDir, "manifest.json"), "utf8"));
    expect(state.state).toBe("committed");
    await generation.close();
  });

  it("closes a superseded generation's rooms and ownership, never a successor's", async () => {
    const dir = tmpRoot();
    const first = await new TurnJournal(dir, AGENT).activate(IDENTITY);
    const room = await first.room(ROOM);
    await room.turnDone("msg-1");
    // The first start failed after activating: its cleanup closes its generation.
    await first.close();

    const second = await new TurnJournal(dir, AGENT).activate(IDENTITY);
    const reopened = await second.room(ROOM);
    expect(reopened.answered("msg-1")).toBe(true);
    // The superseded generation cannot reach the successor's rooms.
    await expect(first.room(ROOM)).rejects.toBeInstanceOf(BandSdkError);
    expect(() => first.release(ROOM)).not.toThrow();
    await expect(first.close()).resolves.toBeUndefined();
    expect(reopened.accepting).toBe(true);
    await second.close();
  });

  it("opens the same room only after a release's close, with every record the closing handle wrote", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const room = await generation.room(ROOM);
    let opens = 0;
    const open = RoomJournal.open.bind(RoomJournal);
    const spy = vi.spyOn(RoomJournal, "open").mockImplementation(async (...args) => {
      opens += 1;
      return await open(...args);
    });
    onTestFinished(() => spy.mockRestore());
    const append = await holdJournalAppend((line) => line.includes('"t":"turn.done"'));
    const done = room.turnDone("msg-1");
    await append.entered;
    generation.release(ROOM);
    const reopening = generation.room(ROOM);
    await flushMicrotasks();
    // The closing handle still owes its write: the room's next handle has not begun to open.
    expect(opens).toBe(0);
    append.release();
    await done;
    const reopened = await reopening;
    expect(reopened).not.toBe(room);
    expect(reopened.answered("msg-1")).toBe(true);
  });

  it("keeps a handle a turn took over from a released room's reply open for the turn's end", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const engine = PublicationEngine.create({ roomId: ROOM, generation, logger: new NoopLogger() });
    // The room is left while a reply posts.
    const posting = createDeferred();
    const post = createDeferred<{ success: true; id: string }>();
    const reply = engine.publishReply("m1", async () => {
      posting.resolve();
      return await post.promise;
    });
    await posting.promise;
    generation.release(ROOM);

    // The room is admitted again, and its next turn holds the room before the reply settles.
    const turn = generation.holdRoom(ROOM);
    const journal = await turn.journal;
    post.resolve({ success: true, id: "posted-1" });
    await reply;

    expect(journal.accepting).toBe(true);
    await journal.turnDone("m2");
    turn.end();
    expect(await recordTypes(roomFile(dir))).toEqual(["reply.intent", "reply.settled", "turn.done"]);
  });

  it("hands an open the room's release overtook to the turn holding it, and opens afresh after the hold ends", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const openEntered = createDeferred();
    const releaseOpen = createDeferred();
    const opened: RoomJournal[] = [];
    const originalOpen = RoomJournal.open.bind(RoomJournal);
    const spy = vi.spyOn(RoomJournal, "open").mockImplementation(async (file, options) => {
      openEntered.resolve();
      await releaseOpen.promise;
      const journal = await originalOpen(file, options);
      opened.push(journal);
      return journal;
    });
    onTestFinished(() => spy.mockRestore());

    // A turn holds the room and opens its journal; the room is left meanwhile.
    const turn = generation.holdRoom(ROOM);
    await openEntered.promise;
    generation.release(ROOM);
    releaseOpen.resolve();

    // The turn keeps the handle it holds; it closes once the hold ends.
    const held = await turn.journal;
    expect(held).toBe(opened[0]);
    await held.turnDone("during-release");
    turn.end();
    expect(held.isClosed).toBe(true);
    // The room's next open is a fresh, live handle.
    const room = await generation.room(ROOM);
    expect(room).toBe(opened[1]);
    expect(room.accepting).toBe(true);
    await room.turnDone("after-open-race");
    expect(await recordTypes(roomFile(dir))).toEqual(["turn.done", "turn.done"]);
  });

  it("stays owned until a room open in flight ends, so a successor's records are never renamed over", async () => {
    const dir = tmpRoot();
    const { journals, generation } = await generationIn(dir);
    const rewrite = await holdJournalRewrite();
    // A turn opens the room's journal; the new file's header is still being written when the generation closes.
    const opening = generation.room(ROOM);
    await rewrite.entered;
    const closing = generation.close();
    await flushMicrotasks();
    // The open may still rename its copy over the file: no successor may own the journal yet.
    await expect(journals.activate(IDENTITY)).rejects.toBeInstanceOf(JournalOwnershipError);
    rewrite.release();
    await closing;
    expect((await opening).isClosed).toBe(true);

    const { generation: successor } = await generationIn(dir);
    await (await successor.room(ROOM)).turnDone("msg-1");
    expect(await recordTypes(roomFile(dir))).toEqual(["turn.done"]);
  });

  it("finishes a release whose room's publications use the room meanwhile", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    await generation.room(ROOM);
    const engine = PublicationEngine.create({ roomId: ROOM, generation, logger: new NoopLogger() });
    const posting = createDeferred();
    const postEntered = createDeferred();
    const reply = engine.publishReply("msg-1", async () => {
      postEntered.resolve();
      await posting.promise;
      return { success: true, id: "post-1" };
    });
    await postEntered.promise;

    // The room is left while its reply posts; a decline admitted meanwhile opens the room the release drains.
    generation.release(ROOM);
    const decline = engine.publishDecline("msg-2", async () => undefined);
    posting.resolve();

    await expect(reply).resolves.toMatchObject({ id: "post-1" });
    await expect(decline).resolves.toBeUndefined();
    expect(await recordTypes(roomFile(dir))).toEqual(["reply.intent", "reply.settled", "decline.settled"]);
  });

  it("waits for the publications serving a message to settle, and no other message's", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const engine = PublicationEngine.create({ roomId: ROOM, generation, logger: new NoopLogger() });
    const posting = { m1: createDeferred(), m2: createDeferred() };
    const posts = { m1: createDeferred<{ success: true; id: string }>(), m2: createDeferred<{ success: true; id: string }>() };
    const first = engine.publishReply("m1", async () => {
      posting.m1.resolve();
      return await posts.m1.promise;
    });
    const second = engine.publishReply("m2", async () => {
      posting.m2.resolve();
      return await posts.m2.promise;
    });
    await posting.m1.promise;
    await posting.m2.promise;

    let settled = false;
    const waiting = generation.settled(ROOM, "m1").then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);
    posts.m1.resolve({ success: true, id: "posted-1" });
    await first;
    // m2's reply still posts: only m1's publications are waited for.
    await waiting;
    expect((await generation.room(ROOM)).answered("m1")).toBe(true);
    posts.m2.resolve({ success: true, id: "posted-2" });
    await second;
  });
});

describe("a room's journal opened directly", () => {
  it("refuses a header that names another agent", async () => {
    const dir = tmpRoot();
    await writeRawFile(dir, IDENTITY, [header(IDENTITY, "agent/other")]);
    await expect(RoomJournal.open(roomFile(dir), roomOptions)).rejects.toBeInstanceOf(JournalFileError);
  });
});

describe("a publication against a closed generation", () => {
  /** A generation whose close beat the publication: its rooms are gone. */
  async function closedGeneration(): Promise<JournalGeneration> {
    const { generation } = await generationIn(tmpRoot());
    await generation.close();
    return generation;
  }

  it("refuses a reply rather than deliver it unjournaled", async () => {
    const engine = PublicationEngine.create({
      roomId: ROOM,
      generation: await closedGeneration(),
      logger: new NoopLogger(),
    });
    let posted = false;
    await expect(engine.publishReply("msg-1", async () => {
      posted = true;
      return { success: true };
    })).rejects.toMatchObject({ kind: "closed" });
    expect(posted).toBe(false);
  });

  it("refuses a decline rather than run it unjournaled", async () => {
    const engine = PublicationEngine.create({
      roomId: ROOM,
      generation: await closedGeneration(),
      logger: new NoopLogger(),
    });
    let ran = false;
    await expect(engine.publishDecline("msg-1", async () => {
      ran = true;
    })).rejects.toMatchObject({ kind: "closed" });
    expect(ran).toBe(false);
  });
});

