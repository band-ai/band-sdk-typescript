import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { RuntimeStateError } from "../src/core/errors";
import { TurnJournal } from "../src/runtime/journal/TurnJournal";
import { DEFAULT_JOURNAL_RETENTION_SECONDS } from "../src/runtime/types";
import { MS_PER_SECOND } from "../src/core/deadline";
import { tmpRoot } from "./testUtils";

const ROOM = "room/with:odd chars";
const RETENTION_MS = DEFAULT_JOURNAL_RETENTION_SECONDS * MS_PER_SECOND;

/** A journal under `dir` on the real clock, or on `clock` when given. */
function journalIn(dir: string, clock?: { now: number }) {
  return new TurnJournal(dir, { retentionMs: RETENTION_MS, ...(clock ? { now: () => clock.now } : {}) });
}

async function fileLines(dir: string): Promise<string[]> {
  const text = await readFile(path.join(dir, `${encodeURIComponent(ROOM)}.jsonl`), "utf8");
  return text.split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { t: string }).t);
}

describe("TurnJournal", () => {
  it("keeps what each inbound's turn answered across a reopen", async () => {
    const dir = tmpRoot();
    const first = await journalIn(dir).room(ROOM);
    const sent = await first.beginReply("m1", { tool: "band_send_message", digest: "d1" });
    await first.replyPosted(sent, { ok: true, id: "posted-1" });
    await first.replyDeclined("m2", { tool: "band_no_reply", digest: "d2" });
    await first.turnDone("m1");

    const reopened = await journalIn(dir).room(ROOM);

    expect(reopened.inbound("m1")).toEqual({ answered: true, done: true, unrecorded: [] });
    expect(reopened.inbound("m2")).toEqual({ answered: true, done: false, unrecorded: [] });
    expect(reopened.inbound("m3")).toEqual({ answered: false, done: false, unrecorded: [] });
  });

  it("reports a reply that may have posted but was never recorded, once", async () => {
    const dir = tmpRoot();
    const journal = await journalIn(dir).room(ROOM);
    await journal.beginReply("m1", { tool: "band_send_message", digest: "d1", operationId: "op-1" });
    const failed = await journal.beginReply("m1", { tool: "band_send_message", digest: "d2" });
    await journal.replyFailed(failed);

    const reopened = await journalIn(dir).room(ROOM);
    const [unrecorded] = reopened.inbound("m1").unrecorded;
    expect(reopened.inbound("m1")).toMatchObject({ answered: false, unrecorded: [{ digest: "d1", operationId: "op-1" }] });

    await reopened.deliveryUnrecorded(unrecorded!);
    expect((await journalIn(dir).room(ROOM)).inbound("m1").unrecorded).toEqual([]);
  });

  it("finds a posted or declined operation by its id, with its payload digest and result", async () => {
    const journal = await journalIn(tmpRoot()).room(ROOM);
    const sent = await journal.beginReply("m1", { tool: "band_send_message", digest: "d1", operationId: "op-1" });
    await journal.replyPosted(sent, { ok: true, id: "posted-1" });
    await journal.replyDeclined("m2", { tool: "band_no_reply", digest: "d2", operationId: "op-2" });
    const pending = await journal.beginReply("m3", { tool: "band_send_message", digest: "d3", operationId: "op-3" });

    expect(journal.operation("op-1")).toEqual({ tool: "band_send_message", digest: "d1", result: { ok: true, id: "posted-1" } });
    expect(journal.operation("op-2")).toMatchObject({ tool: "band_no_reply", digest: "d2" });
    expect(journal.operation("op-3")).toBeUndefined();
    await journal.replyFailed(pending);
    expect(journal.operation("op-3")).toBeUndefined();
  });

  it("ignores a last record a crash cut short", async () => {
    const dir = tmpRoot();
    const journal = await journalIn(dir).room(ROOM);
    await journal.turnDone("m1");
    const [file] = (await readFile(path.join(dir, `${encodeURIComponent(ROOM)}.jsonl`), "utf8")).split("\n");
    expect(file).toContain("turn.done");
    await appendFile(path.join(dir, `${encodeURIComponent(ROOM)}.jsonl`), '{"t":"turn.do');

    const reopened = await journalIn(dir).room(ROOM);
    expect(reopened.inbound("m1").done).toBe(true);
    await reopened.turnDone("m2");
    expect((await journalIn(dir).room(ROOM)).inbound("m2").done).toBe(true);
  });

  it("forgets what a retried inbound's turn answered, including a reply of that turn that lands after the retry", async () => {
    const dir = tmpRoot();
    const journal = await journalIn(dir).room(ROOM);
    const posted = await journal.beginReply("m1", { tool: "band_send_message", digest: "d1" });
    await journal.replyPosted(posted, { ok: true });
    const inFlight = await journal.beginReply("m1", { tool: "band_send_message", digest: "d2" });

    await journal.turnRetried("m1");
    await journal.replyPosted(inFlight, { ok: true });

    const expected = { answered: false, done: false, unrecorded: [] };
    expect(journal.inbound("m1")).toEqual(expected);
    expect((await journalIn(dir).room(ROOM)).inbound("m1")).toEqual(expected);
  });

  it("closes a released room, refusing its later writes, and reopens it with every record it wrote", async () => {
    const journals = journalIn(tmpRoot());
    const released = await journals.room(ROOM);
    const writing = released.turnDone("m1");

    const releasing = journals.release(ROOM);
    const reopened = journals.room(ROOM);
    await writing;
    await releasing;

    await expect(released.turnDone("m2")).rejects.toBeInstanceOf(RuntimeStateError);
    expect(await reopened).not.toBe(released);
    expect((await reopened).inbound("m1").done).toBe(true);
    expect((await reopened).inbound("m2").done).toBe(false);
    await journals.close();
  });

  it("forgets a message whose turn ended here, but keeps it in the file and keeps its operation", async () => {
    const dir = tmpRoot();
    const journal = await journalIn(dir).room(ROOM);
    const sent = await journal.beginReply("m1", { tool: "band_send_message", digest: "d1", operationId: "op-1" });
    await journal.replyPosted(sent, { ok: true });

    await journal.turnDone("m1");

    expect(journal.inbound("m1")).toEqual({ answered: false, done: false, unrecorded: [] });
    expect(journal.operation("op-1")).toMatchObject({ digest: "d1" });
    expect((await journalIn(dir).room(ROOM)).inbound("m1")).toEqual({ answered: true, done: true, unrecorded: [] });
  });

  it("forgets operations and answers older than the retention", async () => {
    const clock = { now: 1_000 };
    const journal = await journalIn(tmpRoot(), clock).room(ROOM);
    await journal.replyDeclined("m1", { tool: "band_no_reply", digest: "d1", operationId: "op-1" });

    clock.now += RETENTION_MS;
    expect(journal.operation("op-1")).toBeDefined();
    expect(journal.inbound("m1").answered).toBe(true);

    clock.now += 1;
    expect(journal.operation("op-1")).toBeUndefined();
    expect(journal.inbound("m1").answered).toBe(false);
  });

  it("drops expired records from the file when it opens, keeping the rest", async () => {
    const dir = tmpRoot();
    const clock = { now: 1_000 };
    const journal = await journalIn(dir, clock).room(ROOM);
    await journal.turnDone("old");
    clock.now += RETENTION_MS / 2;
    await journal.replyDeclined("recent", { tool: "band_no_reply", digest: "d1", operationId: "op-1" });
    await journal.close();
    clock.now += RETENTION_MS / 2 + 1;

    const reopened = await journalIn(dir, clock).room(ROOM);

    expect(await fileLines(dir)).toEqual(["reply.declined"]);
    expect(reopened.inbound("old").done).toBe(false);
    expect(reopened.inbound("recent").answered).toBe(true);
    expect(reopened.operation("op-1")).toBeDefined();
  });

  it("keeps rooms apart", async () => {
    const journals = journalIn(tmpRoot());
    await (await journals.room("room-a")).turnDone("m1");

    expect((await journals.room("room-b")).inbound("m1").done).toBe(false);
    expect(await journals.room("room-a")).toBe(await journals.room("room-a"));
  });
});
