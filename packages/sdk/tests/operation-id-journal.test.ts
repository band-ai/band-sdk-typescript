import { BandError } from "@band-ai/rest-client";

import { describe, expect, it } from "vitest";

import { NoopLogger } from "../src/core/logger";
import { DeliveryFailedError, DeliveryUnknownError } from "../src/core/deliveryFailedError";
import type { JournalGeneration } from "../src/runtime/journal/TurnJournal";
import {
  OPERATION_ID_MAX_BYTES,
  OperationConflictError,
  OperationIdError,
  OperationUnsupportedError,
  operationFingerprint,
  validateOperationId,
} from "../src/runtime/journal/operations";
import { PublicationEngine, unknownOperationMessage } from "../src/runtime/journal/publication";
import { tmpRoot } from "./testUtils";
import { ROOM, diskFull, generationIn, interceptJournalAppends, recordTypes, roomFile, roomJournalIn } from "./turnJournalSupport";

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
  post: () => Promise<{ id: string }>;
} {
  let resolve!: (value: { id: string }) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<{ id: string }>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  let ran = false;
  return {
    promise,
    resolve,
    reject,
    ran: () => ran,
    post: async () => {
      ran = true;
      return promise;
    },
  };
}

/** One engine over `generation`'s room: every keyed operation the tests admit runs through it. */
function engineFor(generation: JournalGeneration, roomId = ROOM) {
  return PublicationEngine.create({
    room: () => generation.room(roomId),
    generation,
    logger: new NoopLogger(),
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

async function until(predicate: () => boolean | Promise<boolean>, timeout = 15000): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("the awaited state never stood");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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
    const room = await generation.room(ROOM);
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
    const room = await generation.room(ROOM);
    // The stored result stands for replays; the receipt rides in it when the transport names one.
    expect(room.operation(ID)).toMatchObject({ outcome: "settled", recipients: ["user-owner"] });
    expect(room.answered("msg-1")).toBe(true);
    await generation.close();
    expect(await recordTypes(roomFile(dir))).toEqual(["op.reserved", "op.recipients", "op.settled", "turn.done"]);
  });

  it("lets a same-id call join the in-flight operation and hear its outcome", async () => {
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
    // The second call arrives while the first's post is still out.
    const second = engine.publishOperation({
      operationId: ID,
      kind: "send",
      content: "hello",
      messageId: "msg-2",
      prepare: sendPreparation(async () => {
        throw new Error("a joiner must never run its own post");
      }),
    });
    post.resolve({ id: "posted-1" });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toMatchObject({ id: "posted-1" });
    expect(secondResult).toMatchObject({ id: "posted-1" });
    const room = await generation.room(ROOM);
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
    await until(() => post.ran());
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
    const room = await generation.room(ROOM);
    expect(room.operation(ID)?.outcome).toBe("settled");
    await generation.close();
    expect(await recordTypes(roomFile(dir))).toEqual(["op.reserved", "op.recipients", "op.settled", "turn.done"]);
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
    const room = await generation.room(ROOM);
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
    const room = await generation.room(ROOM);
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
    const room = await generation.room(ROOM);
    expect(room.operation(ID)?.recipients).toEqual(["user-1"]);
    await generation.close();
  });

  it("stands operations apart across rooms, agents, and platforms", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    await generation.room(ROOM).then(async (_room) => {
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
    const otherRoom = await generation.room("room-two");
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

  it("holds its append lock only until the reservation is durable: another room's turn proceeds while the post is held", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const engine = engineFor(generation);
    const post = heldPost();
    const keyed = engine.publishOperation({
      operationId: ID,
      kind: "send",
      content: "hello",
      messageId: "msg-1",
      prepare: sendPreparation(post.post),
    });
    const other = await generation.room("room-two");
    const publicationId = await other.beginReply("msg-9");
    const otherPost = other.settleReply("msg-9", publicationId, "posted-9");
    await until(async () => (await generation.room(ROOM)).operation(ID)?.recipients !== undefined);
    expect(post.ran()).toBe(true);
    // Room two's reply settles while room one's post still stands out.
    await otherPost;
    expect(other.answered("msg-9")).toBe(true);
    post.resolve({ id: "posted-1" });
    await keyed;
    await generation.close();
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
    const room = await generation.room(ROOM);
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
    expect((await generation.room(ROOM)).operation(ID)?.outcome).toBe("settled");
    await generation.close();
    expect(await recordTypes(roomFile(dir))).toEqual(["op.reserved", "op.recipients", "op.settled", "turn.done"]);
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
    await until(async () => (await generation.room(ROOM)).operation(ID)?.recipients !== undefined);
    // The settle's write, like a full disk, will not land.
    await interceptJournalAppends(async (original, self, args) => {
      if (typeof args[0] === "string" && args[0].includes("op.settled")) throw diskFull();
      await original.apply(self, args);
    });
    post.resolve({ id: "posted-1" });
    const error = await failure;
    const room = await generation.room(ROOM);
    expect(error).toBeInstanceOf(DeliveryUnknownError);
    expect((error as DeliveryUnknownError).message).toBe(unknownOperationMessage());
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
      { messageId: "msg-1", publicationId: "", operationId: ID, outcome: "unknown", at: expect.any(Number) },
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
    expect((error as DeliveryUnknownError).message).toBe(unknownOperationMessage());
    const room = await generation.room(ROOM);
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
    expect((retryError as DeliveryUnknownError).message).toBe(unknownOperationMessage());
    await generation.close();
    expect(await recordTypes(roomFile(dir))).toEqual(["op.reserved", "op.recipients", "op.unknown"]);
  });

  it("records a refused send, and a same-id retry re-reads the refusal without a post", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const engine = engineFor(generation);
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
    ).rejects.toMatchObject({ name: "OperationRefusedError" });
    expect(posts).toBe(0);
    // The refusal owes no settlement credit to either caller.
    const room = await generation.room(ROOM);
    expect(room.operation(ID)?.outcome).toBe("refused");
    expect(room.answered("msg-1")).toBe(false);
    await generation.close();
    expect(await recordTypes(roomFile(dir))).toEqual(["op.reserved", "op.recipients", "op.refused"]);
  });

  it("leaves a keyed send without a journal refused before any post", async () => {
    const engine = PublicationEngine.create({
      room: async () => undefined,
      logger: new NoopLogger(),
    });
    await expect(
      engine.publishOperation({ operationId: ID, kind: "send", content: "hello", messageId: "msg-1", prepare: sendPreparation(async () => ({})) }),
    ).rejects.toThrowError(OperationUnsupportedError);
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
    const room = await generation.room(ROOM);
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
    const engine = engineFor(generation);
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
    const room = await generation.room(ROOM);
    expect(room.operation(ID)?.outcome).toBe("refused");
    expect(room.answered("msg-1")).toBe(false);
    await generation.close();
    expect(await recordTypes(roomFile(dir))).toEqual(["op.reserved", "op.refused"]);
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

describe("the operation index a restarted file rebuilds", () => {
  it("re-admits a leftover reservation it proves was never posted, and stands a leftover post unknown", async () => {
    const dir = tmpRoot();
    const { generation } = await generationIn(dir);
    const room = await generation.room(ROOM);
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
    expect(found).toEqual([{ messageId: "msg-1", publicationId: "", operationId: ID, outcome: "unknown", at: expect.any(Number) }]);
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