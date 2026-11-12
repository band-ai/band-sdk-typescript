import { appendFile, mkdir, readFile } from "node:fs/promises";
import { describe, expect, it, onTestFinished } from "vitest";

import { RecoverableTurnError, RuntimeStateError, ValidationError } from "../src/core/errors";
import { NO_REPLY_RESULT } from "../src/contracts/toolSchemas";
import { agentJournalDir, roomJournalFile, TurnJournal } from "../src/runtime/journal/TurnJournal";
import { DEFAULT_JOURNAL_RETENTION_SECONDS } from "../src/runtime/types";
import { MS_PER_SECOND } from "../src/core/deadline";
import { tmpRoot } from "./testUtils";

const AGENT = "agent/one";
const ROOM = "room/with:odd chars";
const RETENTION_MS = DEFAULT_JOURNAL_RETENTION_SECONDS * MS_PER_SECOND;
/** Writes queued behind a release: enough that a reopen not waiting for the close reads before they land. */
const QUEUED_WRITES = 50;

/** One agent's journal under `dir` on the real clock, or on `clock` when given; closed when the test ends. */
function journalIn(dir: string, clock?: { now: number }, agentId = AGENT): TurnJournal {
  const journals = new TurnJournal(dir, agentId, { retentionMs: RETENTION_MS, ...(clock ? { now: () => clock.now } : {}) });
  onTestFinished(() => journals.close());
  return journals;
}

function roomFile(dir: string, agentId = AGENT): string {
  return roomJournalFile(agentJournalDir(dir, agentId), ROOM);
}

async function fileLines(dir: string): Promise<string[]> {
  const text = await readFile(roomFile(dir), "utf8");
  return text.split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { t: string }).t);
}

describe("TurnJournal", () => {
  it("keeps what each inbound's turn answered across a reopen", async () => {
    const dir = tmpRoot();
    const first = await journalIn(dir).room(ROOM);
    const sent = await first.beginReply("m1", { tool: "band_send_message" });
    await first.replyPosted(sent, { ok: true, id: "posted-1" });
    await first.replyDeclined("m2", { tool: "band_no_reply" }, NO_REPLY_RESULT);
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
    const failed = await journal.beginReply("m1", { tool: "band_send_message" });
    await journal.replyFailed(failed);

    const reopened = await journalIn(dir).room(ROOM);
    const [unrecorded] = reopened.inbound("m1").unrecorded;
    expect(reopened.inbound("m1")).toMatchObject({ answered: false, unrecorded: [{ digest: "d1", operationId: "op-1" }] });

    await reopened.deliveryUnrecorded(unrecorded!);
    const afterReport = await journalIn(dir).room(ROOM);
    expect(afterReport.inbound("m1").unrecorded).toEqual([]);
    expect(afterReport.operation("op-1")).toEqual({ status: "uncertain", tool: "band_send_message", digest: "d1" });
  });

  it("finds a posted or declined operation by its id, with its payload digest and result", async () => {
    const journal = await journalIn(tmpRoot()).room(ROOM);
    const sent = await journal.beginReply("m1", { tool: "band_send_message", digest: "d1", operationId: "op-1" });
    await journal.replyPosted(sent, { ok: true, id: "posted-1" });
    await journal.replyDeclined("m2", { tool: "band_no_reply", digest: "d2", operationId: "op-2" }, NO_REPLY_RESULT);
    const refused = await journal.beginReply("m3", { tool: "band_send_message", digest: "d3", operationId: "op-3" });

    expect(journal.operation("op-1")).toEqual({ status: "landed", tool: "band_send_message", digest: "d1", result: { ok: true, id: "posted-1" } });
    expect(journal.operation("op-2")).toEqual({ status: "landed", tool: "band_no_reply", digest: "d2", result: NO_REPLY_RESULT });
    // Pending with no outcome, and not landing: how it ended is unknown.
    expect(journal.operation("op-3")).toEqual({ status: "uncertain", tool: "band_send_message", digest: "d3" });
    await journal.replyFailed(refused);
    expect(journal.operation("op-3")).toBeUndefined();
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
    expect(await fileLines(dir)).toEqual(["turn.done", "turn.done"]);
    expect((await journalIn(dir).room(ROOM)).inbound("m2").done).toBe(true);
  });

  it("drops a line that parses but is not a record instead of failing the room", async () => {
    const dir = tmpRoot();
    const journal = await journalIn(dir).room(ROOM);
    await journal.turnDone("m1");
    await journal.close();
    await appendFile(roomFile(dir), "null\n{\"t\":\"turn.done\"}\n");

    const reopened = await journalIn(dir).room(ROOM);

    expect(reopened.inbound("m1").done).toBe(true);
    expect(await fileLines(dir)).toEqual(["turn.done"]);
  });

  it("does not let a reply of a retried turn answer the inbound, and still reports it if it never lands", async () => {
    const dir = tmpRoot();
    const journal = await journalIn(dir).room(ROOM);
    const posted = await journal.beginReply("m1", { tool: "band_send_message" });
    await journal.replyPosted(posted, { ok: true });
    const lands = await journal.beginReply("m1", { tool: "band_send_message", digest: "d1", operationId: "op-1" });
    await journal.beginReply("m1", { tool: "band_send_message" });

    await journal.turnRetried("m1");
    await journal.replyPosted(lands, { ok: true, id: "late" });

    expect(journal.inbound("m1")).toMatchObject({ answered: false, done: false });
    // A late post still binds its operation id: a retry under it must not post again.
    expect(journal.operation("op-1")).toMatchObject({ status: "landed", result: { ok: true, id: "late" } });
    const reopened = (await journalIn(dir).room(ROOM)).inbound("m1");
    expect(reopened).toMatchObject({ answered: false, done: false });
    // The third reply has no outcome: delivery uncertain, retried turn or not.
    expect(reopened.unrecorded).toHaveLength(1);
  });

  it("records a reply that lands after its turn ended, and keeps the ended turn's marker", async () => {
    const dir = tmpRoot();
    const journal = await journalIn(dir).room(ROOM);
    const inFlight = await journal.beginReply("m1", { tool: "band_send_message", digest: "d1", operationId: "op-1" });

    await journal.turnDone("m1");
    await journal.replyPosted(inFlight, { ok: true, id: "late" });

    // Kept in memory as on disk, so neither a re-served message nor a retry under the id posts again.
    expect(journal.inbound("m1")).toEqual({ answered: true, done: true, unrecorded: [] });
    expect(journal.operation("op-1")).toMatchObject({ status: "landed", result: { ok: true, id: "late" } });
    const reopened = await journalIn(dir).room(ROOM);
    expect(reopened.inbound("m1")).toEqual({ answered: true, done: true, unrecorded: [] });
    expect(reopened.operation("op-1")).toMatchObject({ status: "landed" });
  });

  it("closes a released room, refusing its later writes, and reopens it with every record it wrote", async () => {
    const journals = journalIn(tmpRoot());
    const released = await journals.room(ROOM);
    const writes = Array.from({ length: QUEUED_WRITES }, (_, index) => released.turnDone(`m${index}`));

    const releasing = journals.release(ROOM);
    const reopened = journals.room(ROOM);
    await Promise.all(writes);
    await releasing;

    await expect(released.turnDone("late")).rejects.toBeInstanceOf(RuntimeStateError);
    expect(await reopened).not.toBe(released);
    expect((await reopened).inbound(`m${QUEUED_WRITES - 1}`).done).toBe(true);
    expect((await reopened).inbound("late").done).toBe(false);
  });

  it("forgets operations and answers older than the retention", async () => {
    const clock = { now: 1_000 };
    const journal = await journalIn(tmpRoot(), clock).room(ROOM);
    await journal.replyDeclined("m1", { tool: "band_no_reply", digest: "d1", operationId: "op-1" }, NO_REPLY_RESULT);

    clock.now += RETENTION_MS;
    expect(journal.operation("op-1")).toBeDefined();
    expect(journal.inbound("m1").answered).toBe(true);

    clock.now += 1;
    expect(journal.operation("op-1")).toBeUndefined();
    expect(journal.inbound("m1").answered).toBe(false);
  });

  it("drops a message's records from the file when its newest one expired, keeping the rest", async () => {
    const dir = tmpRoot();
    const clock = { now: 1_000 };
    const journal = await journalIn(dir, clock).room(ROOM);
    await journal.turnDone("old");
    clock.now += RETENTION_MS / 2;
    await journal.replyDeclined("recent", { tool: "band_no_reply", digest: "d1", operationId: "op-1" }, NO_REPLY_RESULT);
    await journal.close();
    clock.now += RETENTION_MS / 2 + 1;

    const reopened = await journalIn(dir, clock).room(ROOM);

    expect(await fileLines(dir)).toEqual(["reply.declined"]);
    expect(reopened.inbound("old").done).toBe(false);
    expect(reopened.inbound("recent").answered).toBe(true);
    expect(reopened.operation("op-1")).toBeDefined();
  });

  it("keeps a reply's intent while its outcome is inside the retention, though the intent alone is older", async () => {
    const dir = tmpRoot();
    const clock = { now: 1_000 };
    const journal = await journalIn(dir, clock).room(ROOM);
    const pending = await journal.beginReply("m1", { tool: "band_send_message", digest: "d1", operationId: "op-1" });
    clock.now += 50;
    await journal.replyPosted(pending, { ok: true });
    await journal.close();
    // The cutoff falls between the intent and its outcome.
    clock.now += RETENTION_MS - 30;

    const reopened = await journalIn(dir, clock).room(ROOM);

    expect(reopened.inbound("m1").answered).toBe(true);
    expect(reopened.operation("op-1")).toMatchObject({ status: "landed" });
  });

  it("keeps rooms and agents apart", async () => {
    const dir = tmpRoot();
    const journals = journalIn(dir);
    await (await journals.room("room-a")).turnDone("m1");

    expect((await journals.room("room-b")).inbound("m1").done).toBe(false);
    expect(await journals.room("room-a")).toBe(await journals.room("room-a"));
    expect((await journalIn(dir, undefined, "agent-two").room("room-a")).inbound("m1").done).toBe(false);
  });

  it("fails prepare for a journalDir that is not a writable directory", async () => {
    const dir = tmpRoot();
    await appendFile(`${dir}/not-a-dir`, "");

    await expect(journalIn(`${dir}/not-a-dir`).prepare()).rejects.toBeInstanceOf(ValidationError);
    await expect(journalIn(dir).prepare()).resolves.toBeUndefined();
  });

  it("fails a room whose file cannot be read with a turn-scoped error", async () => {
    const dir = tmpRoot();
    await mkdir(roomFile(dir), { recursive: true });

    await expect(journalIn(dir).room(ROOM)).rejects.toBeInstanceOf(RecoverableTurnError);
  });
});
