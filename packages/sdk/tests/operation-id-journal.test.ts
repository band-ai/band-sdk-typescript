import { readFile, writeFile } from "node:fs/promises";

import { BandError } from "@band-ai/rest-client";

import { describe, expect, it, vi } from "vitest";

import type { ToolOperationResult } from "../src/contracts/dtos";
import { DeliveryFailedError, DeliveryUnknownError } from "../src/core/deliveryFailedError";
import type { OperationCheck } from "../src/runtime/journal/RoomJournal";
import {
  OperationConflictError,
  OperationIdError,
  OperationUnsupportedError,
  UNKNOWN_OPERATION_MESSAGES,
  operationFingerprint,
  validateOperationId,
} from "../src/runtime/journal/operations";
import { makeLoggerSpy, tmpRoot } from "./testUtils";
import { AgentTools } from "../src/runtime/tools/AgentTools";
import { AdmissionGuardError } from "../src/runtime/journal/journalTools";
import { toolErrorResult } from "../src/runtime/messageDelivery";
import { buildSingleContextRegistrations } from "../src/mcp/registrations";
import { NO_REPLY_TOOL_NAME, OPERATION_ID_MAX_BYTES, SEND_MESSAGE_TOOL_NAME } from "../src/contracts/toolSchemas";
import { ROOM, diskFull, engineFor, generationIn, holdJournalAppend, interceptJournalAppends, openRoom, recordTypes, roomFile, roomJournalIn } from "./turnJournalSupport";

/** Band's answers, the way the generated client reports them. */
const bandRefused = () =>
  new BandError({ statusCode: 422, body: { error: { code: "unprocessable", message: "Band refused the post", request_id: "req-1" } } });
const bandServerDown = () =>
  new BandError({ statusCode: 503, body: { error: { code: "service_unavailable", message: "Band is unavailable", request_id: "req-2" } } });

function heldPost(): {
  promise: Promise<{ id: string }>;
  resolve: (value: { id: string }) => void;
  reject: (error: unknown) => void;
  ran: () => boolean;
  /** Resolves once the post runs: its recipients already stand durable. */
  started: Promise<void>;
  post: () => Promise<{ id: string }>;
} {
  const answer = Promise.withResolvers<{ id: string }>();
  const started = Promise.withResolvers<void>();
  let ran = false;
  return {
    promise: answer.promise,
    resolve: answer.resolve,
    reject: answer.reject,
    ran: () => ran,
    started: started.promise,
    post: async () => {
      ran = true;
      started.resolve();
      return answer.promise;
    },
  };
}

/** Fails, like a full disk, every journal append whose line carries `record`. */
function failAppendsOf(record: string): Promise<void> {
  return interceptJournalAppends(async (original, self, args) => {
    if (typeof args[0] === "string" && args[0].includes(`"t":"${record}"`)) throw diskFull();
    await original.apply(self, args);
  });
}

/** A keyed send's prepare, posting through `post` with the given first-resolution recipients. */
function sendPreparation(post: () => Promise<unknown>, recipients: string[] = ["user-1"]) {
  return async () => ({
    recipients,
    post: async () => {
      const result: unknown = await post();
      return result as { id?: string; [key: string]: unknown };
    },
  });
}

const ID = "op-1";

describe("a keyed operation's identity", () => {
  it("validates the id to its byte bound, untouched and uninterpreted", () => {
    const atBound = "a".repeat(OPERATION_ID_MAX_BYTES);
    expect(validateOperationId(atBound)).toBe(atBound);
    expect(() => validateOperationId("a".repeat(OPERATION_ID_MAX_BYTES + 1))).toThrowError(OperationIdError);
    expect(() => validateOperationId("")).toThrowError(OperationIdError);
    expect(() => validateOperationId(42)).toThrowError(OperationIdError);
    // The id is opaque: a path-shaped one is no more special than any string.
    expect(validateOperationId("some/deep/path")).toBe("some/deep/path");
  });

  it("folds the kind, the exact content or reason, and the canonical mentions into the fingerprint", () => {
    const send = { kind: "send" as const, content: "hello" };
    expect(operationFingerprint({ ...send, mentions: ["@b", "@a"] })).toBe(operationFingerprint({ ...send, mentions: ["@a ", "@b"] }));
    expect(operationFingerprint({ ...send, mentions: ["@a"] })).not.toBe(operationFingerprint({ ...send, mentions: ["@b"] }));
    expect(operationFingerprint({ ...send, content: "Hello" })).not.toBe(operationFingerprint(send));
    expect(operationFingerprint({ kind: "decline", reason: "fine" })).not.toBe(operationFingerprint({ kind: "send", content: "fine", mentions: undefined }));
  });

  it("refuses a keyed call before any record when its id cannot stand", async () => {
    const { generation } = await generationIn(tmpRoot());
    const engine = engineFor(generation);
    await expect(
      engine.publishOperation({ operationId: "", kind: "send", content: "x", messageId: "msg-1", prepare: sendPreparation(async () => ({})) }),
    ).rejects.toThrowError(OperationIdError);
    const room = await openRoom(generation, ROOM);
    expect(room.operation(ID)).toBeUndefined();
    await generation.close();
  });
});

describe("a keyed send's outcomes", () => {
  it("reserves durably before the post, settles before the result returns, and settles the caller's inbound", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const engine = engineFor(generation);
    const post = heldPost();
    const done = engine.publishOperation({
      operationId: ID,
      kind: "send",
      content: "hello",
      mentions: ["@owner"],
      messageId: "msg-1",
      prepare: sendPreparation(post.post, ["user-owner"]),
    });
    post.resolve({ id: "posted-1" });
    const result = await done;
    expect(result).toMatchObject({ id: "posted-1" });
    expect(post.ran()).toBe(true);
    const room = await openRoom(generation, ROOM);
    // The stored result stands for replays; the receipt rides in it when the transport names one.
    expect(room.operation(ID)).toMatchObject({ outcome: "settled", recipients: ["user-owner"] });
    expect(room.answered("msg-1")).toBe(true);
    await generation.close();
    expect(await recordTypes(roomFile(dir))).toEqual(["op.reserved", "op.recipients", "op.settled", "turn.done"]);
  });

  it("lets a same-id call join the in-flight operation and hear its outcome", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const engine = engineFor(generation);
    const post = heldPost();
    const first = engine.publishOperation({
      operationId: ID,
      kind: "send",
      content: "hello",
      messageId: "msg-1",
      prepare: sendPreparation(post.post),
    });
    // The second call arrives while the first's post is held out.
    await post.started;
    const room = await openRoom(generation, ROOM);
    const check = room.checkAndReserveOperation.bind(room);
    const checked = Promise.withResolvers<OperationCheck>();
    vi.spyOn(room, "checkAndReserveOperation").mockImplementationOnce((input) => {
      const found = check(input);
      checked.resolve(found);
      return found;
    });
    const second = engine.publishOperation({
      operationId: ID,
      kind: "send",
      content: "hello",
      messageId: "msg-2",
      prepare: sendPreparation(async () => {
        throw new Error("a joiner must never run its own post");
      }),
    });
    expect((await checked.promise).status).toBe("inflight");
    // A probe queued behind any write the joiner made: while the post is held,
    // nothing is settled for either caller.
    await check({ operationId: ID, fingerprint: operationFingerprint({ kind: "send", content: "hello" }), kind: "send", messageId: "msg-2" });
    expect(await recordTypes(roomFile(dir))).toEqual(["op.reserved", "op.recipients"]);
    post.resolve({ id: "posted-1" });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toMatchObject({ id: "posted-1" });
    expect(secondResult).toMatchObject({ id: "posted-1" });
    // One operation, one post: both callers' inbounds stand answered.
    expect(room.operation(ID)?.outcome).toBe("settled");
    expect(room.answered("msg-1")).toBe(true);
    expect(room.answered("msg-2")).toBe(true);
    await generation.close();
  });

  it("lets a joiner to a refused operation learn the refusal, not wait for a success", async () => {
    const { generation } = await generationIn(tmpRoot());
    const engine = engineFor(generation);
    const post = heldPost();
    const first = engine.publishOperation({
      operationId: ID,
      kind: "send",
      content: "hello",
      messageId: "msg-1",
      prepare: sendPreparation(post.post),
    });
    const second = engine.publishOperation({
      operationId: ID,
      kind: "send",
      content: "hello",
      messageId: "msg-2",
      prepare: sendPreparation(async () => ({})),
    });
    // Both callers stand on the classified refusal before the post is answered:
    // the platform's raw body never reaches either of them.
    const firstError = first.catch((error: unknown) => error);
    const secondError = second.catch((error: unknown) => error);
    // The post is answered 422 once it stands out: the owner's call has begun awaiting it.
    await post.started;
    post.reject(bandRefused());
    const [firstOutcome, secondOutcome] = await Promise.all([firstError, secondError]);
    expect(firstOutcome).toBeInstanceOf(DeliveryFailedError);
    expect((firstOutcome as Error).message).toBe("the platform refused the post (HTTP 422)");
    expect(secondOutcome).toBeInstanceOf(DeliveryFailedError);
    expect((secondOutcome as Error).message).toBe("the platform refused the post (HTTP 422)");
    await generation.close();
  });

  it("refuses a changed payload or kind before any post, and the refusal records nothing new", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const engine = engineFor(generation);
    await engine.publishOperation({
      operationId: ID,
      kind: "send",
      content: "hello",
      mentions: ["@owner"],
      messageId: "msg-1",
      prepare: sendPreparation(async () => ({ id: "posted-1" })),
    });
    const again = async (input: { kind: "send" | "decline"; content?: string; reason?: string; mentions?: string[] }) => {
      let posted = false;
      await expect(
        engine.publishOperation({
          operationId: ID,
          messageId: "msg-2",
          prepare: sendPreparation(async () => {
            posted = true;
            return {};
          }),
          ...input,
        }),
      ).rejects.toThrowError(OperationConflictError);
      return posted;
    };
    expect(await again({ kind: "send", content: "changed", mentions: ["@owner"] })).toBe(false);
    expect(await again({ kind: "send", content: "hello", mentions: ["@someone-else"] })).toBe(false);
    expect(await again({ kind: "decline", reason: "hello" })).toBe(false);
    const room = await openRoom(generation, ROOM);
    expect(room.operation(ID)?.outcome).toBe("settled");
    await generation.close();
    expect(await recordTypes(roomFile(dir))).toEqual(["op.reserved", "op.recipients", "op.settled", "turn.done"]);
  });

  it("replays a same-id retry that drops a repeated mention: the roster posts both as one", async () => {
    const { generation } = await generationIn(tmpRoot());
    const engine = engineFor(generation);
    const first = await engine.publishOperation({
      operationId: ID,
      kind: "send",
      content: "hello",
      mentions: ["@bob", "@bob"],
      messageId: "msg-1",
      prepare: sendPreparation(async () => ({ id: "posted-1" })),
    });
    const retry = await engine.publishOperation({
      operationId: ID,
      kind: "send",
      content: "hello",
      mentions: ["@bob"],
      messageId: "msg-2",
      prepare: sendPreparation(async () => {
        throw new Error("a replay must never post");
      }),
    });
    expect(retry).toEqual(first);
    const room = await openRoom(generation, ROOM);
    expect(room.answered("msg-2")).toBe(true);
    await generation.close();
  });

  it("stands two ids for the same content apart: each posts, each settles", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const engine = engineFor(generation);
    let posts = 0;
    const post = async () => {
      posts += 1;
      return { id: `posted-${posts}` };
    };
    const [first, second] = await Promise.all([
      engine.publishOperation({ operationId: "op-a", kind: "send", content: "same", messageId: "msg-1", prepare: sendPreparation(post) }),
      engine.publishOperation({ operationId: "op-b", kind: "send", content: "same", messageId: "msg-1", prepare: sendPreparation(post) }),
    ]);
    expect(posts).toBe(2);
    expect(first).not.toMatchObject(second);
    const room = await openRoom(generation, ROOM);
    expect(room.operation("op-a")?.outcome).toBe("settled");
    expect(room.operation("op-b")?.outcome).toBe("settled");
    await generation.close();
    // Two independent operations: each reserved, recorded its first recipients, and settled.
    // Their writes interleave however the writer queues them; the records are what stand.
    const records = await recordTypes(roomFile(dir));
    expect(records.filter((record) => record === "op.reserved")).toHaveLength(2);
    expect(records.filter((record) => record === "op.recipients")).toHaveLength(2);
    expect(records.filter((record) => record === "op.settled")).toHaveLength(2);
    expect(records.filter((record) => record === "turn.done")).toHaveLength(2);
  });

  it("replays a settled operation's stored result without a post, for a later caller", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const engine = engineFor(generation);
    await engine.publishOperation({
      operationId: ID,
      kind: "send",
      content: "hello",
      messageId: "msg-1",
      prepare: sendPreparation(async () => ({ id: "posted-1", status: "ok" })),
    });
    let posts = 0;
    const replay = await engine.publishOperation({
      operationId: ID,
      kind: "send",
      content: "hello",
      messageId: "msg-2",
      prepare: sendPreparation(async () => {
        posts += 1;
        return {};
      }),
    });
    expect(posts).toBe(0);
    expect(replay).toMatchObject({ id: "posted-1", status: "ok" });
    const room = await openRoom(generation, ROOM);
    expect(room.answered("msg-2")).toBe(true);
    await generation.close();
    expect(await recordTypes(roomFile(dir))).toEqual(["op.reserved", "op.recipients", "op.settled", "turn.done", "turn.done"]);
  });

  it("keeps a roster change from retargeting a keyed send: the stored recipients stand", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const engine = engineFor(generation);
    // The first resolution names one user; the roster it stood on is gone by the time a retry would re-resolve.
    await engine.publishOperation({
      operationId: ID,
      kind: "send",
      content: "hello",
      mentions: ["@user-1"],
      messageId: "msg-1",
      prepare: sendPreparation(async () => ({ id: "posted-1" }), ["user-1"]),
    });
    const retry = await engine.publishOperation({
      operationId: ID,
      kind: "send",
      content: "hello",
      mentions: ["@user-1"],
      messageId: "msg-2",
      prepare: sendPreparation(async () => {
        throw new Error("a settled operation never re-resolves the roster");
      }, ["a-wholly-different-user"]),
    });
    expect(retry).toMatchObject({ id: "posted-1" });
    const room = await openRoom(generation, ROOM);
    expect(room.operation(ID)?.recipients).toEqual(["user-1"]);
    await generation.close();
  });

  it("stands operations apart across rooms, agents, and platforms", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    await openRoom(generation, ROOM).then(async () => {
      const engine = engineFor(generation);
      await engine.publishOperation({
        operationId: ID,
        kind: "send",
        content: "hello",
        messageId: "msg-1",
        prepare: sendPreparation(async () => ({ id: "posted-1" })),
      });
    });

    // Another room of the same agent: the same id is a new operation there.
    const otherRoom = await openRoom(generation, "room-two");
    expect(otherRoom.operation(ID)).toBeUndefined();
    // Another agent: its file never holds the first agent's operation.
    const otherAgent = await roomJournalIn(dir, { agentId: "agent/two", roomId: ROOM });
    expect(otherAgent.operation(ID)).toBeUndefined();
    await otherAgent.close();
    // Another platform identity: the journal is bound to its own identity's directory.
    const otherIdentity = await roomJournalIn(dir, { identity: "https://other.example", roomId: ROOM });
    expect(otherIdentity.operation(ID)).toBeUndefined();
    await otherIdentity.close();
    await generation.close();
  });

  it("holds the room's append lock only until the reservation is durable: another turn in the room writes while the post is held", async () => {
    const { generation } = await generationIn(tmpRoot());
    const engine = engineFor(generation);
    const post = heldPost();
    const keyed = engine.publishOperation({
      operationId: ID,
      kind: "send",
      content: "hello",
      messageId: "msg-1",
      prepare: sendPreparation(post.post),
    });
    await post.started;
    // The same room's handle, and so the same write queue, as the held operation's.
    const room = await openRoom(generation, ROOM);
    const publicationId = await room.beginReply("msg-9");
    await room.settleReply("msg-9", publicationId, "posted-9");
    expect(room.answered("msg-9")).toBe(true);
    // The other turn's reply settled while the keyed post still stands out.
    expect(room.operation(ID)?.outcome).toBe("pending");
    post.resolve({ id: "posted-1" });
    await keyed;
    expect(room.operation(ID)?.outcome).toBe("settled");
  });

  it("re-admits a pending operation the file proves it never posted", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const engine = engineFor(generation);
    // The roster resolution fails before the post can run: the file holds the
    // reservation with no recipients, so the post provably never ran.
    const first = engine
      .publishOperation({
        operationId: ID,
        kind: "send",
        content: "hello",
        messageId: "msg-1",
        prepare: async () => {
          throw new Error("the roster resolution failed before any post");
        },
      })
      .catch((error: unknown) => error);
    const failure = await first;
    expect(failure).toBeInstanceOf(Error);
    // The file holds the reservation with no recipients: the post never ran, so
    // the same id may stand for the same operation again and run again.
    const room = await openRoom(generation, ROOM);
    expect(room.operation(ID)?.outcome).toBe("pending");
    // No recipients record stood: the file proves the post never ran.
    expect(room.operation(ID)?.recipients).toBeUndefined();
    const retry = await engine.publishOperation({
      operationId: ID,
      kind: "send",
      content: "hello",
      messageId: "msg-1",
      prepare: sendPreparation(async () => ({ id: "posted-1" })),
    });
    expect(retry).toMatchObject({ id: "posted-1" });
    expect((await openRoom(generation, ROOM)).operation(ID)?.outcome).toBe("settled");
    await generation.close();
    expect(await recordTypes(roomFile(dir))).toEqual(["op.reserved", "op.recipients", "op.settled", "turn.done"]);
  });

  it("releases a send answered 429: the call fails, and a same-id retry posts exactly once", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const engine = engineFor(generation);
    const posted: string[] = [];
    const answers = [
      () => {
        throw new BandError({ statusCode: 429, body: { error: { code: "rate_limited", message: "slow down", request_id: "req-429" } } });
      },
      () => {
        posted.push("hello");
        return { id: "posted-1" };
      },
    ];
    const send = (messageId: string) =>
      engine.publishOperation({
        operationId: ID,
        kind: "send",
        content: "hello",
        messageId,
        prepare: sendPreparation(async () => answers.shift()!()),
      });
    await expect(send("msg-1")).rejects.toMatchObject({ name: "DeliveryFailedError", message: "the platform refused the post (HTTP 429)" });
    // 408/429 come only from infrastructure in front of Band: nothing committed, so the id is not burned.
    expect((await openRoom(generation, ROOM)).operation(ID)).toMatchObject({ outcome: "pending", recipients: undefined });
    expect(await send("msg-1")).toMatchObject({ id: "posted-1" });
    expect(await send("msg-1")).toMatchObject({ id: "posted-1" });
    expect(posted).toEqual(["hello"]);
    await generation.close();
    expect(await recordTypes(roomFile(dir))).toEqual(["op.reserved", "op.recipients", "op.released", "op.recipients", "op.settled", "turn.done", "turn.done"]);
  });

  it("keeps a call re-admitted behind a release in flight: a later same-id call joins it once the released call ends", async () => {
    const { generation } = await generationIn(tmpRoot());
    const engine = engineFor(generation);
    const rateLimited = () => {
      throw new BandError({ statusCode: 429, body: { error: { code: "rate_limited", message: "slow down", request_id: "req-429" } } });
    };
    const send = (messageId: string, post: () => Promise<unknown>) =>
      engine.publishOperation({ operationId: ID, kind: "send", content: "hello", messageId, prepare: sendPreparation(post) });
    const releaseHeld = await holdJournalAppend((line) => line.includes('"op.released"'));
    const released = send("msg-1", async () => rateLimited()).catch((error: unknown) => error);
    await releaseHeld.entered;
    // Queued behind the release's write: the release re-admits it as the operation's new owner.
    const readmittedPost = heldPost();
    const readmitted = send("msg-2", readmittedPost.post);
    releaseHeld.release();
    expect(await released).toMatchObject({ message: "the platform refused the post (HTTP 429)" });
    await readmittedPost.started;
    const joiner = send("msg-3", async () => {
      throw new Error("a joiner must never run its own post");
    });
    readmittedPost.resolve({ id: "posted-1" });
    expect(await readmitted).toMatchObject({ id: "posted-1" });
    expect(await joiner).toMatchObject({ id: "posted-1" });
  });

  it("releases a send whose turn is cut short after its recipients stand: a reopen announces nothing, and a same-id retry posts", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const stop = new AbortController();
    let posts = 0;
    const cut = engineFor(generation).publishOperation({
      operationId: ID,
      kind: "send",
      content: "hello",
      messageId: "msg-1",
      // The stop lands while the roster resolves: the recipients still stand, the post must not run.
      prepare: async () => {
        stop.abort("stop");
        return await sendPreparation(async () => {
          posts += 1;
          return { id: "never" };
        })();
      },
      stopped: stop.signal,
    });
    await expect(cut).rejects.toMatchObject({ name: "RuntimeStateError" });
    expect(posts).toBe(0);
    await generation.close();
    expect(await recordTypes(roomFile(dir))).toEqual(["op.reserved", "op.recipients", "op.released"]);

    const { generation: next } = await generationIn(dir);
    expect(await (await openRoom(next, ROOM)).recoverUnresolved()).toEqual([]);
    const retry = await engineFor(next).publishOperation({
      operationId: ID,
      kind: "send",
      content: "hello",
      messageId: "msg-1",
      prepare: sendPreparation(async () => ({ id: "posted-1" })),
    });
    expect(retry).toMatchObject({ id: "posted-1" });
    await next.close();
  });

  it("stands a post Band answered but the file could not settle unknown, and poisons the writer", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const engine = engineFor(generation);
    const post = heldPost();
    const failure = engine
      .publishOperation({
        operationId: ID,
        kind: "send",
        content: "hello",
        messageId: "msg-1",
        prepare: sendPreparation(post.post),
      })
      .catch((error: unknown) => error);
    await post.started;
    // The settle's write, like a full disk, will not land.
    await failAppendsOf("op.settled");
    post.resolve({ id: "posted-1" });
    const error = await failure;
    const room = await openRoom(generation, ROOM);
    expect(error).toBeInstanceOf(DeliveryUnknownError);
    expect((error as DeliveryUnknownError).message).toBe(UNKNOWN_OPERATION_MESSAGES.send);
    expect(room.accepting).toBe(false);
    await generation.close();
    // The writer that owed the settle stands poisoned, and the file it left holds
    // nothing after the reservation and its recipients. A fresh handle reads the
    // operation as the process that lost the settle's write must report it: a
    // possibly-posted operation stands unknown, and a same-id call joins it.
    const reopened = await roomJournalIn(dir);
    const check = await reopened.checkAndReserveOperation({
      operationId: ID,
      fingerprint: operationFingerprint({ kind: "send", content: "hello" }),
      kind: "send",
      messageId: "msg-1",
    });
    expect(check.status).toBe("unknown");
    expect(await reopened.recoverUnresolved()).toEqual([
      { kind: "operation", messageId: "msg-1", operationId: ID, outcome: "unknown", at: expect.any(Number) },
    ]);
    await reopened.close();
  });

  it("stands a post Band answered with no response unknown: the operator hears the operation's text, and a same-id retry reposts nothing", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const engine = engineFor(generation);
    const first = engine
      .publishOperation({
        operationId: ID,
        kind: "send",
        content: "hello",
        messageId: "msg-1",
        prepare: sendPreparation(async () => {
          throw bandServerDown();
        }),
      })
      .catch((error: unknown) => error);
    const error = await first;
    expect(error).toBeInstanceOf(DeliveryUnknownError);
    expect((error as DeliveryUnknownError).message).toBe(UNKNOWN_OPERATION_MESSAGES.send);
    const room = await openRoom(generation, ROOM);
    expect(room.operation(ID)?.outcome).toBe("unknown");
    // The retry joins the unknown: zero posts, the same text.
    let posts = 0;
    const retry = engine
      .publishOperation({
        operationId: ID,
        kind: "send",
        content: "hello",
        messageId: "msg-2",
        prepare: sendPreparation(async () => {
          posts += 1;
          return {};
        }),
      })
      .catch((retryError: unknown) => retryError);
    const retryError = await retry;
    expect(posts).toBe(0);
    expect(retryError).toBeInstanceOf(DeliveryUnknownError);
    expect((retryError as DeliveryUnknownError).message).toBe(UNKNOWN_OPERATION_MESSAGES.send);
    await generation.close();
    expect(await recordTypes(roomFile(dir))).toEqual(["op.reserved", "op.recipients", "op.unknown"]);
  });

  it("stands a send whose acknowledgment does not stand as a stored result unknown: no credit, and a retry reposts nothing", async () => {
    // The store would coerce an acknowledgment it cannot prove — a lossy
    // value, or not a result at all — so the operation stands unknown on no
    // copy: settled for no caller, never re-posted as a success.
    for (const broken of [null, { invalid: Number.NaN }]) {
      const dir = tmpRoot();
      const { generation } = await generationIn(dir);
      const engine = engineFor(generation);
      const error = await engine
        .publishOperation({
          operationId: ID,
          kind: "send",
          content: "hello",
          messageId: "msg-1",
          prepare: sendPreparation(async () => broken),
        })
        .catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(DeliveryUnknownError);
      expect((error as DeliveryUnknownError).message).toBe(UNKNOWN_OPERATION_MESSAGES.send);
      const room = await openRoom(generation, ROOM);
      expect(room.operation(ID)?.outcome).toBe("unknown");
      // The caller's inbound is credited nothing: the journal cannot prove the post.
      expect(room.answered("msg-1")).toBe(false);
      let posts = 0;
      const retry = await engine
        .publishOperation({
          operationId: ID,
          kind: "send",
          content: "hello",
          messageId: "msg-2",
          prepare: sendPreparation(async () => {
            posts += 1;
            return {};
          }),
        })
        .catch((thrown: unknown) => thrown);
      expect(posts).toBe(0);
      expect(retry).toBeInstanceOf(DeliveryUnknownError);
      expect((retry as DeliveryUnknownError).message).toBe(UNKNOWN_OPERATION_MESSAGES.send);
      await generation.close();
      expect(await recordTypes(roomFile(dir))).toEqual(["op.reserved", "op.recipients", "op.unknown"]);
    }
  });

  it("refuses a send whose acknowledgment stands as a failure, and the refusal credits no caller", async () => {
    for (const failure of [{ ok: false }, { status: "failed" }]) {
      const dir = tmpRoot();
      const { generation } = await generationIn(dir);
      const engine = engineFor(generation);
      await expect(
        engine.publishOperation({
          operationId: ID,
          kind: "send",
          content: "hello",
          messageId: "msg-1",
          prepare: sendPreparation(async () => failure),
        }),
      ).rejects.toThrowError(DeliveryFailedError);
      const room = await openRoom(generation, ROOM);
      expect(room.operation(ID)?.outcome).toBe("refused");
      expect(room.answered("msg-1")).toBe(false);
      let posts = 0;
      await expect(
        engine.publishOperation({
          operationId: ID,
          kind: "send",
          content: "hello",
          messageId: "msg-2",
          prepare: sendPreparation(async () => {
            posts += 1;
            return {};
          }),
        }),
      ).rejects.toMatchObject({ name: "DeliveryFailedError", message: "the post was refused before it reached Band" });
      expect(posts).toBe(0);
      await generation.close();
      expect(await recordTypes(roomFile(dir))).toEqual(["op.reserved", "op.recipients", "op.refused"]);
    }
  });

  it("records a refused send, and a same-id retry re-reads the refusal without a post", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const logger = makeLoggerSpy();
    const engine = engineFor(generation, ROOM, logger);
    await expect(
      engine.publishOperation({
        operationId: ID,
        kind: "send",
        content: "hello",
        messageId: "msg-1",
        prepare: sendPreparation(async () => {
          throw bandRefused();
        }),
      }),
    ).rejects.toMatchObject({ name: "DeliveryFailedError", message: "the platform refused the post (HTTP 422)" });
    let posts = 0;
    await expect(
      engine.publishOperation({
        operationId: ID,
        kind: "send",
        content: "hello",
        messageId: "msg-2",
        prepare: sendPreparation(async () => {
          posts += 1;
          return {};
        }),
      }),
    ).rejects.toMatchObject({ name: "DeliveryFailedError", message: "the platform refused the post (HTTP 422)" });
    expect(posts).toBe(0);
    // The operator learns the refusal's class and status once, never Band's raw message.
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("refused"), {
      roomId: ROOM,
      operationId: ID,
      reason: "the platform refused the post (HTTP 422)",
      errorClass: "BandError",
    });
    // The refusal owes no settlement credit to either caller.
    const room = await openRoom(generation, ROOM);
    expect(room.operation(ID)?.outcome).toBe("refused");
    expect(room.answered("msg-1")).toBe(false);
    await generation.close();
    expect(await recordTypes(roomFile(dir))).toEqual(["op.reserved", "op.recipients", "op.refused"]);
  });

  it("refuses a keyed send on a closed generation before any post", async () => {
    const { generation } = await generationIn(tmpRoot());
    const engine = engineFor(generation);
    await generation.close();
    const post = heldPost();
    await expect(
      engine.publishOperation({ operationId: ID, kind: "send", content: "hello", messageId: "msg-1", prepare: sendPreparation(post.post) }),
    ).rejects.toMatchObject({ name: "JournalPublicationError", kind: "closed" });
    expect(post.ran()).toBe(false);
  });
});

describe("a keyed no-reply", () => {
  it("settles the decline durably, posts nothing, and replays the standing no-reply", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const engine = engineFor(generation);
    const result = await engine.publishOperation({
      operationId: ID,
      kind: "decline",
      reason: "nothing to answer",
      messageId: "msg-1",
      runDecline: async () => ({ status: "ok" }),
    });
    expect(result).toMatchObject({ status: "ok" });
    const room = await openRoom(generation, ROOM);
    expect(room.operation(ID)).toMatchObject({ outcome: "settled", kind: "decline" });
    expect(room.answered("msg-1")).toBe(true);
    let ran = 0;
    const replay = await engine.publishOperation({
      operationId: ID,
      kind: "decline",
      reason: "nothing to answer",
      messageId: "msg-2",
      runDecline: async () => {
        ran += 1;
        return { status: "ok" };
      },
    });
    expect(ran).toBe(0);
    expect(replay).toMatchObject({ status: "ok" });
    await generation.close();
    expect(await recordTypes(roomFile(dir))).toEqual(["op.reserved", "op.settled", "decline.settled", "decline.settled"]);
  });

  it("refuses a decline the harness refuses, records the refusal, and owes no settlement", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const logger = makeLoggerSpy();
    const engine = engineFor(generation, ROOM, logger);
    await expect(
      engine.publishOperation({
        operationId: ID,
        kind: "decline",
        reason: "no",
        messageId: "msg-1",
        runDecline: async () => {
          throw new Error("the harness declined to decline");
        },
      }),
    ).rejects.toThrowError("the harness could not run this no-reply");
    // The harness's failure is logged by its class, never its message.
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("refused"), {
      roomId: ROOM,
      operationId: ID,
      reason: "the harness could not run this no-reply",
      errorClass: "Error",
    });
    const room = await openRoom(generation, ROOM);
    expect(room.operation(ID)?.outcome).toBe("refused");
    expect(room.answered("msg-1")).toBe(false);
    await generation.close();
    expect(await recordTypes(roomFile(dir))).toEqual(["op.reserved", "op.refused"]);
  });

  it("stands a decline whose decision does not stand as a stored result unknown: nothing is credited, and a retry re-reads the unknown", async () => {
    // A decline that resolves to a value the store cannot prove — a lossy
    // object, or not a result at all — did not stand: it settles unknown,
    // the reply is not credited as declined, and a same-id retry re-reads
    // the unknown rather than re-running the decision as a success.
    for (const broken of [null, { invalid: Number.NaN }]) {
      const dir = tmpRoot();
      const { generation } = await generationIn(dir);
      const engine = engineFor(generation);
      const error = await engine
        .publishOperation({
          operationId: ID,
          kind: "decline",
          reason: "nothing to answer",
          messageId: "msg-1",
          runDecline: async () => broken as unknown as ToolOperationResult,
        })
        .catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(DeliveryUnknownError);
      expect((error as DeliveryUnknownError).message).toBe(UNKNOWN_OPERATION_MESSAGES.decline);
      const room = await openRoom(generation, ROOM);
      expect(room.operation(ID)?.outcome).toBe("unknown");
      expect(room.answered("msg-1")).toBe(false);
      let ran = 0;
      const retry = await engine
        .publishOperation({
          operationId: ID,
          kind: "decline",
          reason: "nothing to answer",
          messageId: "msg-2",
          runDecline: async () => {
            ran += 1;
            return { status: "ok" };
          },
        })
        .catch((thrown: unknown) => thrown);
      expect(ran).toBe(0);
      expect(retry).toBeInstanceOf(DeliveryUnknownError);
      expect((retry as DeliveryUnknownError).message).toBe(UNKNOWN_OPERATION_MESSAGES.decline);
      await generation.close();
      expect(await recordTypes(roomFile(dir))).toEqual(["op.reserved", "op.unknown"]);
    }
  });

  it("refuses a decline whose decision stands as a failure, and owes no settlement", async () => {
    for (const failure of [{ ok: false }, { status: "failed" }]) {
      const dir = tmpRoot();
      const { generation } = await generationIn(dir);
      const engine = engineFor(generation);
      await expect(
        engine.publishOperation({
          operationId: ID,
          kind: "decline",
          reason: "no",
          messageId: "msg-1",
          runDecline: async () => failure,
        }),
      ).rejects.toThrowError(DeliveryFailedError);
      const room = await openRoom(generation, ROOM);
      expect(room.operation(ID)?.outcome).toBe("refused");
      expect(room.answered("msg-1")).toBe(false);
      let ran = 0;
      await expect(
        engine.publishOperation({
          operationId: ID,
          kind: "decline",
          reason: "no",
          messageId: "msg-2",
          runDecline: async () => {
            ran += 1;
            return { status: "ok" };
          },
        }),
      ).rejects.toMatchObject({ name: "DeliveryFailedError", message: "the post was refused before it reached Band" });
      expect(ran).toBe(0);
      await generation.close();
      expect(await recordTypes(roomFile(dir))).toEqual(["op.reserved", "op.refused"]);
    }
  });

  it("collides a send and a no-reply that reuse one id", async () => {
    const { generation } = await generationIn(tmpRoot());
    const engine = engineFor(generation);
    await engine.publishOperation({
      operationId: ID,
      kind: "decline",
      reason: "no",
      messageId: "msg-1",
      runDecline: async () => ({ status: "ok" }),
    });
    await expect(
      engine.publishOperation({
        operationId: ID,
        kind: "send",
        content: "no",
        messageId: "msg-2",
        prepare: sendPreparation(async () => ({ id: "posted-1" })),
      }),
    ).rejects.toThrowError(OperationConflictError);
    await generation.close();
  });
});

describe("the authority a journal file proves at load", () => {
  /** Settles `ID`'s send through a real engine, closes the process, and rewrites the settled record's stored authority in the file. */
  async function settledFileWithAuthority(authority: string | undefined): Promise<string> {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const engine = engineFor(generation);
    await engine.publishOperation({
      operationId: ID,
      kind: "send",
      content: "hello",
      messageId: "msg-1",
      prepare: sendPreparation(async () => ({ id: "posted-1" })),
    });
    await generation.close();
    const file = roomFile(dir);
    const lines = (await readFile(file, "utf8")).split("\n");
    const at = lines.findIndex((line) => line.includes('"t":"op.settled"'));
    expect(at).toBeGreaterThanOrEqual(0);
    const record = JSON.parse(lines[at]) as Record<string, unknown>;
    if (authority === undefined) delete record.resultJson;
    else record.resultJson = authority;
    lines[at] = JSON.stringify(record);
    await writeFile(file, lines.join("\n"));
    return dir;
  }

  it("refuses a file that settled a send with authority that does not stand, before the journal is admitted", async () => {
    // No result at all, a result that does not parse, and results that stand
    // as failures are not authority this engine's settlements could store:
    // the file is refused while it is read, and the engine stands fail-closed
    // behind it — nothing in the room is admitted, credited, or replayed.
    for (const authority of [undefined, "{broken-json", JSON.stringify({ ok: false }), JSON.stringify({ status: "failed" })]) {
      const dir = await settledFileWithAuthority(authority);
      const { generation } = await generationIn(dir);
      await expect(openRoom(generation, ROOM)).rejects.toMatchObject({ name: "JournalFileError", kind: "corrupt" });
      const engine = engineFor(generation);
      let posts = 0;
      await expect(
        engine.publishOperation({
          operationId: "op-fresh",
          kind: "send",
          content: "fresh",
          messageId: "msg-9",
          prepare: sendPreparation(async () => {
            posts += 1;
            return {};
          }),
        }),
      ).rejects.toMatchObject({ name: "JournalFileError", kind: "corrupt" });
      expect(posts).toBe(0);
      await generation.close();
    }
  });

  it("admits a file whose settled authority stands, credits the answered inbound, and replays the stored result", async () => {
    const dir = await settledFileWithAuthority(JSON.stringify({ id: "posted-1" }));
    const { generation } = await generationIn(dir);
    const room = await openRoom(generation, ROOM);
    expect(room.operation(ID)).toMatchObject({ outcome: "settled" });
    expect(room.answered("msg-1")).toBe(true);
    const engine = engineFor(generation);
    const replay = await engine.publishOperation({
      operationId: ID,
      kind: "send",
      content: "hello",
      messageId: "msg-9",
      prepare: sendPreparation(async () => {
        throw new Error("a replay must not post");
      }),
    });
    expect(replay).toMatchObject({ id: "posted-1" });
    await generation.close();
  });
});

describe("the operation index a restarted file rebuilds", () => {
  it("re-admits a leftover reservation it proves was never posted, and stands a leftover post unknown", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const room = await openRoom(generation, ROOM);
    const fingerprint = operationFingerprint({ kind: "send", content: "hello" });
    // The first process admits two sends: one records its first recipients and its
    // post is lost in flight, the other stands on its reservation alone.
    const first = await room.checkAndReserveOperation({ operationId: ID, fingerprint, kind: "send", messageId: "msg-1" });
    expect(first.status).toBe("reserved");
    await room.storeOperationRecipients(ID, ["user-1"]);
    const never = await room.checkAndReserveOperation({ operationId: "op-never-posted", fingerprint, kind: "send", messageId: "msg-1" });
    expect(never.status).toBe("reserved");
    await generation.close();

    const reopened = await roomJournalIn(dir);
    // The possibly-posted operation stands unknown, announced once with its id.
    const found = await reopened.recoverUnresolved();
    expect(found).toEqual([{ kind: "operation", messageId: "msg-1", operationId: ID, outcome: "unknown", at: expect.any(Number) }]);
    expect(await reopened.recoverUnresolved()).toEqual([]);
    // A same-id call to a possibly-posted operation joins the unknown and posts nothing.
    const retry = await reopened.checkAndReserveOperation({ operationId: ID, fingerprint, kind: "send", messageId: "msg-1" });
    expect(retry.status).toBe("unknown");
    // The provably unposted one was never announced, and the same id is re-admissible.
    const recheck = await reopened.checkAndReserveOperation({ operationId: "op-never-posted", fingerprint, kind: "send", messageId: "msg-1" });
    expect(recheck.status).toBe("reserved");
    await reopened.close();
  });
});

describe("a keyed refusal through the tool door", () => {
  it("answers a keyed refusal, its replay, and a conflict as routine refusals, never logged as unexpected", async () => {
    const { generation } = await generationIn(tmpRoot());
    const logger = makeLoggerSpy();
    const rest = {
      listChatParticipants: async () => [{ id: "user-1", name: "Owner", type: "User", handle: "owner" }],
      createChatMessageOnce: async () => {
        throw bandRefused();
      },
      hasOnceCapability: () => true,
    } as never;
    const tools = new AgentTools({ roomId: ROOM, rest, publication: engineFor(generation, ROOM, logger), inboundMessageId: () => "msg-1", logger });
    const send = () => tools.executeToolCall(SEND_MESSAGE_TOOL_NAME, { content: "hello", mentions: ["@owner"], operation_id: ID });
    const refused = { ok: false, errorType: "ToolExecutionError", message: expect.stringContaining("the platform refused the post (HTTP 422)") };
    expect(await send()).toMatchObject(refused);
    expect(await send()).toMatchObject(refused);
    expect(await tools.executeToolCall(NO_REPLY_TOOL_NAME, { reason: "fyi", operation_id: ID })).toMatchObject({
      ok: false,
      message: new OperationConflictError(ID).message,
    });
    expect(logger.error).not.toHaveBeenCalled();
    await generation.close();
  });

  it.each([
    ["an invalid id", new OperationIdError("empty")],
    ["a room without a journal", new OperationUnsupportedError("no-journal")],
    ["an admission that could not be read", new AdmissionGuardError()],
  ])("answers a keyed call refused for %s as a routine refusal, never logged as unexpected", (_case, refusal) => {
    const logger = makeLoggerSpy();
    expect(toolErrorResult(SEND_MESSAGE_TOOL_NAME, refusal, logger)).toMatchObject({ ok: false, errorType: "ToolExecutionError", message: expect.stringContaining(refusal.message) });
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe("where operation_id is advertised", () => {
  const advertised = (schemas: Array<{ name?: string; input_schema?: { properties: Record<string, unknown> } }>) =>
    schemas.filter((schema) => schema.input_schema !== undefined && "operation_id" in schema.input_schema.properties).map((schema) => schema.name).sort();
  const rest = (once: boolean) =>
    ({
      createChatMessage: async () => ({ id: "m1" }),
      ...(once ? { createChatMessageOnce: async () => ({ id: "m1" }), hasOnceCapability: () => true } : {}),
    }) as never;

  it("offers a model no operation_id unless its room journals replies and posts single-attempt", async () => {
    const { generation } = await generationIn(tmpRoot());
    const publication = engineFor(generation);
    try {
      expect(advertised(new AgentTools({ roomId: ROOM, rest: rest(true) }).getAnthropicToolSchemas())).toEqual([]);
      expect(advertised(new AgentTools({ roomId: ROOM, rest: rest(false), publication, inboundMessageId: () => "msg-1" }).getAnthropicToolSchemas())).toEqual([]);
      // A turn with no inbound to settle (a contact hub's synthetic turn) serves no keyed operation.
      expect(advertised(new AgentTools({ roomId: ROOM, rest: rest(true), publication }).getAnthropicToolSchemas())).toEqual([]);
      expect(advertised(new AgentTools({ roomId: ROOM, rest: rest(true), publication, inboundMessageId: () => "msg-1" }).getAnthropicToolSchemas())).toEqual([
        NO_REPLY_TOOL_NAME,
        SEND_MESSAGE_TOOL_NAME,
      ]);
    } finally {
      await generation.close();
    }
  });

  it("offers an MCP client operation_id only when the server enables it", () => {
    const tools = new AgentTools({ roomId: ROOM, rest: rest(true) }).getAdapterTools();
    const keyed = (enableOperationIds?: boolean) =>
      buildSingleContextRegistrations(tools, { enableOperationIds })
        .filter((registration) => "operation_id" in registration.inputSchema.properties)
        .map((registration) => registration.name)
        .sort();
    expect(keyed()).toEqual([]);
    expect(keyed(true)).toEqual([NO_REPLY_TOOL_NAME, SEND_MESSAGE_TOOL_NAME]);
  });
});

describe("a keyed operation whose own records fail to land", () => {
  it("lands a definite refusal through a rewrite, so a reopen neither announces it nor reads it unknown", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const engine = engineFor(generation);
    await failAppendsOf("op.refused");
    const error = await engine
      .publishOperation({ operationId: ID, kind: "send", content: "hello", mentions: ["user-1"], messageId: "msg-1", prepare: sendPreparation(async () => { throw bandRefused(); }) })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(DeliveryFailedError);
    expect(error).not.toBeInstanceOf(DeliveryUnknownError);
    await generation.close();

    const reopened = await roomJournalIn(dir);
    const check = await reopened.checkAndReserveOperation({
      operationId: ID,
      fingerprint: operationFingerprint({ kind: "send", content: "hello", mentions: ["user-1"] }),
      kind: "send",
      messageId: "msg-2",
    });
    const announced = await reopened.recoverUnresolved();
    await reopened.close();
    expect(check).toMatchObject({ status: "refused", reasonText: "the platform refused the post (HTTP 422)" });
    expect(announced).toEqual([]);
  });

  it.each([
    ["writes nothing", false],
    ["writes its line but not its sync", true],
  ])("lands a re-admitted send's second release through a rewrite that %s, in file order", async (_case, lineLands) => {
    const dir = tmpRoot();
    // One instant stamps every record: the two releases are byte-identical lines.
    const { generation } = await generationIn(dir, { now: () => 1000 });
    const engine = engineFor(generation);
    let releases = 0;
    await interceptJournalAppends(async (original, self, args) => {
      if (typeof args[0] === "string" && args[0].includes('"t":"op.released"') && ++releases === 2) {
        if (lineLands) await original.apply(self, args);
        throw diskFull();
      }
      await original.apply(self, args);
    });
    const send = (messageId: string) =>
      engine.publishOperation({
        operationId: ID,
        kind: "send",
        content: "hello",
        messageId,
        prepare: sendPreparation(async () => {
          throw new BandError({ statusCode: 429, body: { error: { code: "rate_limited", message: "slow down", request_id: "req-429" } } });
        }),
      });
    await expect(send("msg-1")).rejects.toMatchObject({ message: "the platform refused the post (HTTP 429)" });
    await expect(send("msg-1")).rejects.toMatchObject({ message: "the platform refused the post (HTTP 429)" });
    await generation.close();
    expect(await recordTypes(roomFile(dir))).toEqual(["op.reserved", "op.recipients", "op.released", "op.recipients", "op.released"]);

    const reopened = await roomJournalIn(dir);
    expect(reopened.operation(ID)).toMatchObject({ outcome: "pending", recipients: undefined });
    await reopened.close();
  });

  it("announces an unknown operation once per generation, even when its announcement record fails to land", async () => {
    const { generation } = await generationIn(tmpRoot());
    await engineFor(generation)
      .publishOperation({ operationId: ID, kind: "send", content: "hello", messageId: "msg-1", prepare: sendPreparation(async () => { throw bandServerDown(); }) })
      .catch(() => undefined);
    generation.release(ROOM);
    await failAppendsOf("op.reported");
    const first = await (await openRoom(generation, ROOM)).recoverUnresolved();
    expect(first).toEqual([expect.objectContaining({ kind: "operation", operationId: ID })]);
    // The room's next handle reopens a file that never recorded the announcement.
    generation.release(ROOM);
    expect(await (await openRoom(generation, ROOM)).recoverUnresolved()).toEqual([]);
  });

  it("returns a posted send's stored result when only its caller's settlement fails to land", async () => {
    const { generation } = await generationIn(tmpRoot());
    const engine = engineFor(generation);
    await failAppendsOf("turn.done");
    let posts = 0;
    const result = await engine.publishOperation({
      operationId: ID,
      kind: "send",
      content: "hello",
      messageId: "msg-1",
      prepare: sendPreparation(async () => {
        posts += 1;
        return { id: "posted-1" };
      }),
    });
    const room = await openRoom(generation, ROOM);
    expect(result).toEqual({ id: "posted-1" });
    expect(posts).toBe(1);
    // The settlement answered the inbound; the writer that lost a write stops admitting.
    expect(room.operation(ID)?.outcome).toBe("settled");
    expect(room.answered("msg-1")).toBe(true);
    expect(room.accepting).toBe(false);
    await generation.close();
  });

  it("stands a decline whose settlement fails to land under the decline's unknown text", async () => {
    const { generation } = await generationIn(tmpRoot());
    const engine = engineFor(generation);
    await failAppendsOf("op.settled");
    const error = await engine
      .publishOperation({ operationId: ID, kind: "decline", reason: "fyi", messageId: "msg-1", runDecline: async () => ({ status: "ok" }) })
      .catch((thrown: unknown) => thrown);
    await generation.close();
    expect(error).toBeInstanceOf(DeliveryUnknownError);
    expect((error as DeliveryUnknownError).message).toBe(UNKNOWN_OPERATION_MESSAGES.decline);
  });

  it("reports a keyed decline's unknown to an MCP client under the decline's text, not a post's", async () => {
    const { generation } = await generationIn(tmpRoot());
    const publication = engineFor(generation);
    await failAppendsOf("op.settled");
    const tools = new AgentTools({ roomId: ROOM, rest: {} as never, publication, inboundMessageId: () => "msg-1" });
    const noReply = buildSingleContextRegistrations(tools.getAdapterTools(), { enableOperationIds: true })
      .find((registration) => registration.name === NO_REPLY_TOOL_NAME)!;
    const result = await noReply.execute({ reason: "fyi", operation_id: ID });
    await generation.close();
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({ kind: DeliveryUnknownError.KIND, detail: UNKNOWN_OPERATION_MESSAGES.decline });
  });

  it("warns that an operation stands recorded unknown only when its record landed", async () => {
    const { generation } = await generationIn(tmpRoot());
    const logger = makeLoggerSpy();
    const engine = engineFor(generation, ROOM, logger);
    await failAppendsOf("op.unknown");
    const error = await engine
      .publishOperation({ operationId: ID, kind: "send", content: "hello", messageId: "msg-1", prepare: sendPreparation(async () => { throw bandServerDown(); }) })
      .catch((thrown: unknown) => thrown);
    await generation.close();
    expect(error).toBeInstanceOf(DeliveryUnknownError);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("its record failed to land"), expect.anything());
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("records it as unknown"), expect.anything());
  });
});
