import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { describe, expect, it, onTestFinished } from "vitest";

import { BandSdkError } from "../src/core/errors";
import { JournalFileError, JournalPublicationError } from "../src/runtime/journal/errors";
import { identityDirectoryComponent, roomFileComponent } from "../src/runtime/journal/records";
import { migrateTurnJournals } from "../src/runtime/journal/migration";
import { RoomJournal } from "../src/runtime/journal/RoomJournal";
import { TurnJournal, agentJournalDir, roomFileName } from "../src/runtime/journal/TurnJournal";
import { JournalOwnershipError } from "../src/runtime/journal/ownership";
import { tmpRoot } from "./testUtils";
import {
  AGENT,
  IDENTITY,
  OTHER_IDENTITY,
  ROOM,
  diskFull,
  generationIn,
  holdJournalAppend,
  interceptJournalAppends,
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
    const append = await holdJournalAppend((line) => line.includes('"t":"reply.intent"'));
    const begin = room.beginReply("msg-1");
    const posted = { ran: false };
    const settle = begin.then(async (publicationId) => {
      posted.ran = true;
      return room.settleReply("msg-1", publicationId, "posted-1");
    });
    await append.entered;
    // The intent is not on disk yet: the post that waits on it has not run.
    expect(posted.ran).toBe(false);
    append.release();
    await settle;
    expect(posted.ran).toBe(true);
    expect(await recordTypes(roomFile(dir))).toEqual(["reply.intent", "reply.settled"]);
    expect(room.answered("msg-1")).toBe(true);
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
  });

  it("announces an unknown publication once, on first open, and never again", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const room = await generation.room(ROOM);
    const publicationId = await room.beginReply("msg-1");
    await room.markUnknown("msg-1", publicationId);
    await generation.close();

    const second = await new TurnJournal(dir, AGENT).activate(IDENTITY);
    const reopened = await second.room(ROOM);
    const found = await reopened.recoverUnresolved();
    expect(found).toEqual([{ messageId: "msg-1", publicationId, outcome: "unknown", at: expect.any(Number) }]);
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

  it("keeps the durable intent when a disk will not take the settlement", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const room = await generation.room(ROOM);
    const publicationId = await room.beginReply("msg-1");
    await interceptJournalAppends(async (original, self, args) =>
      typeof args[0] === "string" && args[0].includes("reply.settled") ? Promise.reject(diskFull()) : original.apply(self, args));

    await expect(room.settleReply("msg-1", publicationId, "posted-1")).rejects.toBeInstanceOf(JournalFileError);
    // The intent stands on disk; the settlement does not.
    expect(await recordTypes(roomFile(dir))).toEqual(["reply.intent"]);
    // A later outcome that the file will take still goes out; the engine, not the file,
    // poisons the room when an owed outcome could not be recorded.
    await room.markUnknown("msg-1", publicationId);
    expect(room.accepting).toBe(true);
    expect(await recordTypes(roomFile(dir))).toEqual(["reply.intent", "reply.unknown"]);
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
      `${JSON.stringify({ v: 1, state: "prepared", createdAt: 1, bindings: [{ sourceFile: legacyRoomFile(ROOM), roomId: ROOM, sourceSha256, platformIdentity: IDENTITY, provenance: "crash" }] }, null, 2)}\n`,
    );

    const generation = await new TurnJournal(dir, otherAgent).activate(IDENTITY);
    const reopened = await generation.room(ROOM);
    expect(reopened.answered("old")).toBe(true);
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
    await expect(first.release(ROOM)).resolves.toBeUndefined();
    await expect(first.close()).resolves.toBeUndefined();
    await second.drain();
    expect(reopened.accepting).toBe(true);
    await second.close();
  });

  it("opens the same room only after a release's close, with every record the closing handle wrote", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const room = await generation.room(ROOM);
    await room.turnDone("msg-1");
    const reopening = generation.room(ROOM);
    await generation.release(ROOM);
    const reopened = await reopening;
    expect(reopened.answered("msg-1")).toBe(true);
  });
});

describe("a room's journal opened directly", () => {
  it("refuses a header that names another agent", async () => {
    const dir = tmpRoot();
    await writeRawFile(dir, IDENTITY, [header(IDENTITY, "agent/other")]);
    await expect(RoomJournal.open(roomFile(dir), roomOptions)).rejects.toBeInstanceOf(JournalFileError);
  });
});

