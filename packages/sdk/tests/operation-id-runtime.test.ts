import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BandError } from "@band-ai/rest-client";

import { describe, expect, it, onTestFinished } from "vitest";

import { GenericAdapter, type GenericAdapterHandler } from "../src/adapters/GenericAdapter";
import { createDeferred } from "../src/core/deferred";
import { relayReply } from "../src/core/turn";
import { createBandSdkMcpServer } from "../src/mcp/sdk";
import { PlatformRuntime } from "../src/runtime";
import { DeliveryUnknownError, DeliveryFailedError } from "../src/core/deliveryFailedError";
import { unknownOperationMessage } from "../src/runtime/journal/publication";
import { OperationConflictError } from "../src/runtime/journal/operations";
import type { SessionConfig } from "../src/runtime/types";
import type { AgentEvent } from "../src/contracts/events";
import { AGENT_API_KEY, AGENT_ID, BandPlatform, person } from "./flows/support/bandPlatform";
import { RecordLog, tmpRoot } from "./testUtils";
import { IDENTITY, holdJournalAppend, recordTypes, roomFile } from "./turnJournalSupport";

const OWNER = "owner";
const ROOM = "room-1";
const OTHER_ROOM = "room-2";
const MENTION = `@[[${AGENT_ID}]]`;
const OP_ID = "op-restart-1";
/** A stop that waits for nothing: the process is killed with its turn and marks in flight. */
const KILL = 0;

type Handler = GenericAdapterHandler;

interface ProcessHandle {
  runtime: PlatformRuntime;
  handled: string[];
  events: RecordLog<AgentEvent>;
  /** The handler's completion or failure, propagated out of the adapter's catch: an assertion a handler could not swallow. */
  handlerOutcome: Promise<{ ok: true } | { ok: false; error: unknown }>;
}

async function startProcess(
  platform: BandPlatform,
  journalDir: string,
  handler: Handler,
  options: { sessionConfig?: Omit<SessionConfig, "journalDir"> } = {},
): Promise<ProcessHandle> {
  const { sessionConfig = {} } = options;
  const handled: string[] = [];
  const events = new RecordLog<AgentEvent>();
  const runtime = new PlatformRuntime({
    agentId: AGENT_ID,
    apiKey: AGENT_API_KEY,
    linkOptions: platform.link,
    agentConfig: { autoSubscribeExistingRooms: true },
    sessionConfig: { ...sessionConfig, journalDir, journalPlatformIdentity: sessionConfig.journalPlatformIdentity ?? IDENTITY },
  });
  runtime.observe((event) => {
    events.record(event);
  });
  const outcome = createDeferred<{ ok: true } | { ok: false; error: unknown }>();
  let outcomeSettled = false;
  const settleOutcome = (value: { ok: true } | { ok: false; error: unknown }) => {
    if (!outcomeSettled) {
      outcomeSettled = true;
      outcome.resolve(value);
    }
  };
  onTestFinished(() => settleOutcome({ ok: true }));
  onTestFinished(async () => {
    if (runtime.state.status === "running") await runtime.stop(KILL);
  });
  await runtime.start(
    new GenericAdapter(async (args) => {
      handled.push(String(args.message.id));
      try {
        await handler(args);
        settleOutcome({ ok: true });
      } catch (error) {
        // The adapter reports the failure to the room; the test still learns of
        // it, so an assertion a handler threw on is a test failure here.
        settleOutcome({ ok: false, error });
        throw error;
      }
    }),
  );
  return { runtime, handled, events, handlerOutcome: outcome.promise };
}

function journalFile(journalDir: string, roomId: string = ROOM): string {
  return roomFile(journalDir, IDENTITY, AGENT_ID, roomId);
}

const journalRecords = (journalDir: string, roomId: string = ROOM) => recordTypes(journalFile(journalDir, roomId));

/** The room's journal records; an empty list while the file stands not yet created. */
async function recordsOf(journalDir: string, roomId: string = ROOM): Promise<string[]> {
  try {
    return await journalRecords(journalDir, roomId);
  } catch {
    return [];
  }
}

async function until(predicate: () => boolean | Promise<boolean>, timeout = 15000): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("the awaited state never stood");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const recordsContain = (journalDir: string, record: string, roomId: string = ROOM) =>
  recordsOf(journalDir, roomId).then((records) => records.includes(record));

const reported = (events: RecordLog<AgentEvent>) =>
  events.entries.filter((event) => event.type === "delivery.unrecorded");

/** The outcomes a platform has settled for `messageId`, as observed: a call that starts
 * after the settlement stands behind it, unlike a `next` waiter that only sees new ones. */
const settledOutcomes = (platform: BandPlatform, messageId: string) =>
  platform.rest.settled.entries.filter((entry) => entry.messageId === messageId).map((entry) => entry.outcome);

const settledAs = (platform: BandPlatform, messageId: string, outcome: string) =>
  until(async () => settledOutcomes(platform, messageId).includes(outcome as never), 60000);

/**
 * A stop that tears the process down can cut the settle mark's report short; the
 * platform still records it when the report lands, so a hard-killed test waits
 * longer than a live one for the same mark.
 */
const settledAsAfterKill = (platform: BandPlatform, messageId: string, outcome: string) =>
  until(async () => settledOutcomes(platform, messageId).includes(outcome as never), 150000);

const postedContents = (platform: BandPlatform, roomId?: string) =>
  platform.rest.posted.entries
    .filter(({ messageType }) => messageType !== "error")
    .filter((entry) => roomId === undefined || entry.roomId === roomId)
    .map(({ content }) => content);

describe("a keyed operation's process boundary", () => {
  it("stands a killed process's possibly-posted operation unknown: a restart announces it, a same-id retry reposts nothing, and the next turn proceeds", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} keyed send please`);
    // The once post reaches Band; when the process is stopped, the transport's report
    // of the attempt is everything the process learns — committed or not, it cannot say.
    const lostResponse = createDeferred<unknown>();
    onTestFinished(() => lostResponse.resolve(undefined));
    let failOnResponse = false;
    const unavailable = new BandError({
      statusCode: 503,
      body: { error: { code: "service_unavailable", message: "Band is unavailable", request_id: "req-kill" } },
    });
    platform.rest.createChatMessageOnce = async (roomId, message, options) => {
      const accepted = await platform.rest.createChatMessage(roomId, message, options);
      await lostResponse.promise;
      if (failOnResponse) throw unavailable;
      return { ...accepted, status: "ok" };
    };

    const first = await startProcess(platform, journalDir, async ({ tools }) => {
      const bridge = createBandSdkMcpServer({ enableMemoryTools: false, getToolsForRoom: () => tools });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await bridge.serverConfig.instance.connect(serverTransport);
      const client = new Client({ name: "op-restart-1", version: "1.0.0" });
      await client.connect(clientTransport);
      try {
        await client.callTool({
          name: "band_send_message",
          arguments: { room_id: ROOM, content: "keyed lost", mentions: [OWNER], operation_id: OP_ID },
        });
      } finally {
        await client.close();
      }
    });
    await until(() => recordsContain(journalDir, "op.recipients"));
    // The process stops while the post stands unanswered: the attempt's report is a
    // 5xx, so the outcome stands unknown, and the stop's drain completes on it.
    failOnResponse = true;
    lostResponse.resolve(undefined);
    await first.runtime.stop(KILL);
    // The file holds the reservation, its first-resolution recipients, and the unknown
    // outcome: whether Band committed the post, no later process can say.
    expect(await recordsOf(journalDir)).toContain("op.recipients");
    expect(await recordsOf(journalDir)).toContain("op.unknown");
    expect(await recordsOf(journalDir)).not.toContain("op.settled");
    // Band holds the post: it stands in the platform's transcript (the turn's failure
    // notice is the runtime's, not the operation's).
    expect(postedContents(platform)).toEqual(["keyed lost"]);

    let retryIsError: boolean | undefined;
    const seen: Array<Record<string, unknown>> = [];
    let relayed = true;
    const second = await startProcess(platform, journalDir, async (args) => {
      const { tools } = args;
      // The successor turn is unaffected by the old operation: it answers plainly.
      if (String(args.message.content).includes("next")) {
        relayed = false;
        await relayReply(tools, "next answered", [OWNER]);
        return;
      }
      const bridge = createBandSdkMcpServer({ enableMemoryTools: false, getToolsForRoom: () => tools });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await bridge.serverConfig.instance.connect(serverTransport);
      const client = new Client({ name: "op-restart-2", version: "1.0.0" });
      await client.connect(clientTransport);
      try {
        // The retry joins the stored unknown: no post, the operation's stable text.
        const retry = await client.callTool({
          name: "band_send_message",
          arguments: { room_id: ROOM, content: "keyed lost", mentions: [OWNER], operation_id: OP_ID },
        });
        retryIsError = Boolean(retry.isError);
        seen.push(JSON.parse((retry.content as Array<{ text: string }>)[0].text));
        // The turn is fenced: no unkeyed replacement may stand in it.
        relayed = await relayReply(tools, "unkeyed fallback", [OWNER]);
      } finally {
        await client.close();
      }
    });
    await settledAs(platform, inbound, "failed");
    await first.handlerOutcome;
    await second.handlerOutcome;
    expect(retryIsError).toBe(true);
    expect(relayed).toBe(false);
    expect(seen).toEqual([{ kind: DeliveryUnknownError.KIND, detail: unknownOperationMessage() }]);
    expect(postedContents(platform)).toEqual(["keyed lost"]);
    // The restart announced the operation exactly once, with its id, and the turn's
    // unknown delivery rides the same report. The announcement rides the room's
    // admission, which runs after start resolves: wait for it to land.
    await until(() => reported(second.events).some(({ messageId, operationId }) => messageId === inbound && operationId === OP_ID));
    const unrecorded = reported(second.events);
    expect(unrecorded.filter(({ messageId, operationId }) => messageId === inbound && operationId === OP_ID)).toHaveLength(1);
    // A successor turn is unaffected by the old operation: it replies and settles.
    const next = await room.say(OWNER, `${MENTION} next`);
    await settledAs(platform, next, "processed");
    expect(settledOutcomes(platform, next)).toContain("processed");
    expect(postedContents(platform)).toEqual(["keyed lost", "next answered"]);
    await first.runtime.stop(KILL).catch(() => undefined);
  }, 180000);

  it("re-admits a leftover operation the file proves was never posted, and says nothing to the operator", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} keyed send please`);
    // The operation's recipients write stands held, then dropped: the process dies
    // with it unrecorded, so the file proves the post never ran. The drop settles
    // the in-flight operation, so the kill's drain completes.
    const held = await holdJournalAppend((line) => line.includes('"op.recipients"'), { drop: true });
    const first = await startProcess(platform, journalDir, async ({ tools }) => {
      const bridge = createBandSdkMcpServer({ enableMemoryTools: false, getToolsForRoom: () => tools });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await bridge.serverConfig.instance.connect(serverTransport);
      const client = new Client({ name: "op-pending-1", version: "1.0.0" });
      await client.connect(clientTransport);
      try {
        await client.callTool({
          name: "band_send_message",
          arguments: { room_id: ROOM, content: "pending never posted", mentions: [OWNER], operation_id: OP_ID },
        });
      } finally {
        await client.close();
      }
    });
    await until(() => recordsContain(journalDir, "op.reserved"));
    await held.entered;
    held.release();
    await first.runtime.stop(KILL);
    expect(await recordsOf(journalDir)).not.toContain("op.recipients");
    // The cut-short turn's failure notice is the runtime's; the operation itself
    // never posted anything.
    expect(postedContents(platform)).toEqual([]);

    let retryIsError: boolean | undefined;
    let retryText = "";
    const second = await startProcess(platform, journalDir, async ({ tools }) => {
      const bridge = createBandSdkMcpServer({ enableMemoryTools: false, getToolsForRoom: () => tools });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await bridge.serverConfig.instance.connect(serverTransport);
      const client = new Client({ name: "op-pending-2", version: "1.0.0" });
      await client.connect(clientTransport);
      try {
        const result = await client.callTool({
          name: "band_send_message",
          arguments: { room_id: ROOM, content: "pending never posted", mentions: [OWNER], operation_id: OP_ID },
        });
        retryIsError = Boolean(result.isError);
        retryText = (result.content as Array<{ text: string }>)[0]?.text ?? "";
      } finally {
        await client.close();
      }
    });
    await until(() => recordsContain(journalDir, "op.settled"));
    await second.handlerOutcome;
    // The provably unposted operation was never announced on either admission.
    expect(reported(second.events)).toEqual([]);
    // The same id re-ran: it posted once and settled, and the call answered.
    expect(retryIsError).toBeFalsy();
    expect(retryText).toBeTruthy();
    expect(postedContents(platform)).toEqual(["pending never posted"]);
    await settledAs(platform, inbound, "processed");
    const records = await recordsOf(journalDir);
    // The re-admission resumes the standing reservation: one reservation record,
    // then the new process's recipients and settlement.
    expect(records.filter((record) => record === "op.reserved")).toHaveLength(1);
    expect(records).toContain("op.settled");
    await first.runtime.stop(KILL).catch(() => undefined);
  });

  it("settles a keyed no-reply durably without any post, and a later call joins the standing no-reply", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} fyi only`);
    let first: unknown;
    let second: unknown;
    await startProcess(platform, journalDir, async ({ tools }) => {
      first = await tools.executeToolCall("band_no_reply", { room_id: ROOM, reason: "fyi only", operation_id: OP_ID });
      second = await tools.executeToolCall("band_no_reply", { room_id: ROOM, reason: "fyi only", operation_id: OP_ID });
    });
    await until(() => recordsContain(journalDir, "decline.settled"));
    await settledAs(platform, inbound, "processed");
    expect(first).toEqual({ status: "ok" });
    expect(second).toEqual({ status: "ok" });
    expect(platform.rest.posted.entries).toEqual([]);
    expect(platform.rest.deliveries).toEqual([]);
    const records = await recordsOf(journalDir);
    // The decline settled once for the first call; the joining call recorded its
    // own decline settlement without a second reservation.
    expect(records.filter((record) => record === "op.reserved")).toHaveLength(1);
    expect(records.filter((record) => record === "op.settled")).toHaveLength(1);
    expect(records.filter((record) => record === "decline.settled")).toHaveLength(2);
    expect(records).toContain("turn.done");
  });

  it("keeps the original operation settled when a changed payload conflicts: the conflict caller's turn fails, and a same-id retry replays the original result without a post", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} direct keyed please`);
    let first: unknown;
    let conflict: unknown;
    const firstHandle = await startProcess(platform, journalDir, async ({ tools }) => {
      first = await tools.sendMessage("direct keyed", [OWNER], { operationId: OP_ID });
      conflict = await tools.sendMessage("direct changed", [OWNER], { operationId: OP_ID }).catch((error) => error);
    });
    // Both calls ran: the first settled, the second was refused.
    const firstOutcome = await firstHandle.handlerOutcome;
    expect(firstOutcome.ok).toBe(true);
    // The first send answered: it stands settled, with its stored result.
    expect(typeof first).toBe("object");
    expect((first as { id?: string }).id).toBeTruthy();
    // The changed payload conflicts with the standing operation: it is refused
    // before any post, and the refusal stands under the conflict.
    expect(conflict).toBeInstanceOf(DeliveryFailedError);
    expect((conflict as DeliveryFailedError).cause).toBeInstanceOf(OperationConflictError);
    // The conflict stands refused: one post, the changed content never ran.
    expect(postedContents(platform, ROOM)).toEqual(["direct keyed"]);
    await firstHandle.runtime.stop(KILL);
    // The successor process stands up first: if the killed process's settle mark
    // never reached Band, the platform redelivers the message to the successor,
    // whose journal says it is answered, so the mark is repaired there.
    let replay: unknown;
    const retry = await startProcess(platform, journalDir, async ({ tools }) => {
      replay = await tools.sendMessage("direct keyed", [OWNER], { operationId: OP_ID });
    });
    // A same-id retry on a later process replays the original stored result:
    // the original operation stands settled-success, unchanged by the conflict.
    const retryInbound = await room.say(OWNER, `${MENTION} retry please`);
    await retry.handlerOutcome;
    expect(typeof replay).toBe("object");
    expect((replay as { id?: string }).id).toBe((first as { id: string }).id);
    // The replay posted nothing: the original post stands for every same-id call.
    expect(postedContents(platform, ROOM)).toEqual(["direct keyed"]);
    // The replaying caller's own turn settles processed on the replayed result.
    await settledAsAfterKill(platform, retryInbound, "processed");
    // The original caller's mark stands either from the killed process's in-flight
    // report or the successor's repair of the redelivered message.
    await settledAsAfterKill(platform, inbound, "processed");
    await retry.runtime.stop(KILL);

    // A later caller that takes the id with a changed payload is the conflict:
    // its turn gets no reply and settles failed; the original operation stands untouched.
    let laterConflict: unknown;
    const conflictProcess = await startProcess(platform, journalDir, async ({ tools }) => {
      laterConflict = await tools
        .sendMessage("direct changed", [OWNER], { operationId: OP_ID })
        .catch((error) => error);
    });
    const conflictInbound = await room.say(OWNER, `${MENTION} changed payload please`);
    await conflictProcess.handlerOutcome;
    expect(laterConflict).toBeInstanceOf(DeliveryFailedError);
    expect((laterConflict as DeliveryFailedError).cause).toBeInstanceOf(OperationConflictError);
    await settledAsAfterKill(platform, conflictInbound, "failed");
    expect(postedContents(platform, ROOM)).toEqual(["direct keyed"]);
    const finalRecords = await recordsOf(journalDir);
    // The conflict changed nothing durable: the original reservation stands once.
    expect(finalRecords.filter((record) => record === "op.reserved")).toHaveLength(1);
    await conflictProcess.runtime.stop(KILL);
  }, 400000);

  it("refuses keyed sends a backend without the once port, before any record or post", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} keyed please`);
    // Strip the once port: this backend cannot stand a single-attempt post.
    (platform.rest as { createChatMessageOnce?: unknown }).createChatMessageOnce = undefined;
    let refused: unknown;
    const first = await startProcess(platform, journalDir, async ({ tools }) => {
      refused = await tools.executeToolCall("band_send_message", {
        room_id: ROOM,
        content: "cannot stand",
        mentions: [OWNER],
        operation_id: OP_ID,
      });
    });
    await settledAs(platform, inbound, "failed");
    await first.handlerOutcome;
    expect(refused).toMatchObject({ ok: false, errorType: "ToolExecutionError" });
    expect(typeof (refused as { message?: unknown }).message === "string" ? (refused as { message: string }).message : "").toBeTruthy();
    // The refusal stands before any durable operation: no record, and the keyed
    // content never stands; the turn's own failure notice is the runtime's, not the operation's.
    const records = await recordsOf(journalDir);
    expect(records).not.toContain("op.reserved");
    expect(postedContents(platform)).toEqual([]);
    // A later turn on the same backend refuses the same way: no inference from history.
    await first.runtime.stop(KILL);
    let refusedAgain: unknown;
    const second = await startProcess(platform, journalDir, async ({ tools }) => {
      refusedAgain = await tools.executeToolCall("band_send_message", {
        room_id: ROOM,
        content: "cannot stand",
        mentions: [OWNER],
        operation_id: OP_ID,
      });
    });
    const again = await room.say(OWNER, `${MENTION} keyed again`);
    await settledAs(platform, again, "failed");
    await second.handlerOutcome;
    expect(refusedAgain).toMatchObject({ ok: false, errorType: "ToolExecutionError" });
    expect(postedContents(platform)).toEqual([]);
    const recordsAgain = await recordsOf(journalDir);
    expect(recordsAgain).not.toContain("op.reserved");
  }, 180000);

  it("refuses a non-string operation id on the direct path before any post, and fences the turn on the field's presence", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} numeric id please`);
    let result: unknown;
    let relayed = true;
    await startProcess(platform, journalDir, async ({ tools }) => {
      // A numeric id is not a string: the call is refused before any
      // reservation, post, or settlement — and it never falls to the legacy
      // delivery the dropped id would have run.
      result = await tools.executeToolCall("band_send_message", {
        room_id: ROOM,
        content: "numeric ID must not post",
        mentions: [OWNER],
        operation_id: 123,
      });
      // The keyed call fenced the turn on its field's presence: the closing
      // text stands nowhere, even though the call never posted.
      relayed = await relayReply(tools, "automatic unkeyed replacement", [OWNER]);
    });
    await settledAs(platform, inbound, "failed");
    expect(result).toMatchObject({ ok: false, errorType: "ToolExecutionError" });
    expect(typeof (result as { message?: unknown }).message === "string" ? (result as { message: string }).message : "").toBeTruthy();
    expect(relayed).toBe(false);
    expect(postedContents(platform, ROOM)).toEqual([]);
    const records = await recordsOf(journalDir);
    expect(records).not.toContain("op.reserved");
  });

  it("fences a directly invoked unsupported keyed request before its closing text relays unkeyed", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} unsupported keyed please`);
    (platform.rest as { createChatMessageOnce?: unknown }).createChatMessageOnce = undefined;
    let refusal: unknown;
    let relayed = true;
    await startProcess(platform, journalDir, async ({ tools }) => {
      refusal = await tools.executeToolCall("band_send_message", {
        room_id: ROOM,
        content: "unsupported keyed",
        mentions: [OWNER],
        operation_id: "unsupported",
      });
      relayed = await relayReply(tools, "automatic unkeyed replacement", [OWNER]);
    });
    await settledAs(platform, inbound, "failed");
    expect(refusal).toMatchObject({ ok: false, errorType: "ToolExecutionError" });
    // The turn committed to keyed delivery on the call's field: its closing text
    // is not relayed as an unkeyed replacement on top of the refused operation.
    expect(relayed).toBe(false);
    expect(postedContents(platform, ROOM)).toEqual([]);
  });
});

describe("the MCP bridge's keyed admission", () => {
  async function keyedCall(client: Client, arguments_: Record<string, unknown>) {
    try {
      const result = await client.callTool({ name: "band_send_message", arguments: arguments_ });
      return { thrown: false as const, isError: Boolean(result.isError), text: (result.content as Array<{ text: string }>)[0]?.text ?? "" };
    } catch (error) {
      return { thrown: true as const, isError: true, text: error instanceof Error ? error.message : String(error) };
    }
  }

  it("fences a turn on a schema-invalid operation id before any business runs, and leaves an unrelated room unfenced", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const otherRoom = await platform.room(OTHER_ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} keyed please`);
    const otherInbound = otherRoom.postBeforeConnect(OWNER, `${MENTION} other room please`);

    let fenced: boolean | undefined;
    let otherRelayed = false;
    let invalid: { thrown: boolean; isError: boolean; text: string } | undefined;
    await startProcess(platform, journalDir, async (args) => {
      const { tools } = args;
      if (args.roomId !== ROOM) {
        otherRelayed = await relayReply(tools, "other room answered", [OWNER]);
        return;
      }
      const bridge = createBandSdkMcpServer({ enableMemoryTools: false, getToolsForRoom: () => tools });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await bridge.serverConfig.instance.connect(serverTransport);
      const client = new Client({ name: "op-mcp-1", version: "1.0.0" });
      await client.connect(clientTransport);
      try {
        // A numeric id cannot stand: the published schema refuses it at the bridge.
        invalid = await keyedCall(client, { room_id: ROOM, content: "x", mentions: [OWNER], operation_id: 123 });
        // The turn is fenced on admission: an unkeyed closing relay stands nowhere.
        fenced = await relayReply(tools, "unkeyed fallback", [OWNER]);
      } finally {
        await client.close();
      }
    });
    await settledAs(platform, inbound, "failed");
    expect(invalid).toMatchObject({ thrown: false, isError: true });
    expect(invalid?.text).toBeTruthy();
    expect(fenced).toBe(false);
    // Nothing unkeyed stands in the fenced room: only its failure notice.
    expect(postedContents(platform, ROOM)).toEqual([]);
    // The fence stands for the turn that admitted the bad call: nothing unkeyed was posted for it.
    await settledAs(platform, otherInbound, "processed");
    expect(otherRelayed).toBe(true);
    expect(postedContents(platform, OTHER_ROOM)).toEqual(["other room answered"]);
    // No business ever ran in the fenced turn: the journal holds no operation for it.
    const records = await recordsOf(journalDir);
    expect(records).not.toContain("op.reserved");
    expect(records).not.toContain("reply.intent");
  }, 120000);

  it("answers a valid id with another invalid argument through the strict schema, and a valid keyed send through the bridge posts once", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} keyed please`);
    const outcomes: Array<{ thrown: boolean; isError: boolean; text: string }> = [];
    let relayed: boolean | undefined;
    await startProcess(platform, journalDir, async ({ tools }) => {
      const bridge = createBandSdkMcpServer({ enableMemoryTools: false, getToolsForRoom: () => tools });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await bridge.serverConfig.instance.connect(serverTransport);
      const client = new Client({ name: "op-mcp-2", version: "1.0.0" });
      await client.connect(clientTransport);
      try {
        // The id stands; content is not a string. The schema refuses the call; the
        // id still fenced the turn at admission.
        outcomes.push(await keyedCall(client, {
          room_id: ROOM,
          content: 42,
          mentions: [OWNER],
          operation_id: OP_ID,
        }));
        outcomes.push(await keyedCall(client, {
          room_id: ROOM,
          content: "keyed through bridge",
          mentions: [OWNER],
          operation_id: OP_ID,
        }));
        // A same-id retry in the same turn joins the stored result.
        outcomes.push(await keyedCall(client, {
          room_id: ROOM,
          content: "keyed through bridge",
          mentions: [OWNER],
          operation_id: OP_ID,
        }));
        relayed = await relayReply(tools, "unkeyed after", [OWNER]);
      } finally {
        await client.close();
      }
    });
    await until(() => recordsContain(journalDir, "op.settled"));
    await settledAs(platform, inbound, "processed");
    expect(postedContents(platform, ROOM)).toEqual(["keyed through bridge"]);
    // The invalid call was refused with a nonempty schema error; the keyed call and
    // its replay both stood without a second post.
    const [invalid, keyed, replay] = outcomes;
    expect(invalid).toMatchObject({ thrown: false, isError: true });
    expect(invalid.text).toBeTruthy();
    expect(keyed).toMatchObject({ thrown: false, isError: false });
    expect(replay).toMatchObject({ thrown: false, isError: false });
    // The keyed call fenced the turn: no unkeyed closing text stands after it.
    expect(relayed).toBe(false);
    const records = await recordsOf(journalDir);
    expect(records.filter((record) => record === "op.reserved")).toHaveLength(1);
    expect(records).toContain("op.settled");
  });

  it("reports a keyed unknown through the bridge with the operation's text, and one POST stands total", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} keyed please`);
    // The post reaches Band and is answered 503: committed or not, the process cannot say.
    platform.rest.createChatMessageOnce = async (roomId, message, options) => {
      await platform.rest.createChatMessage(roomId, message, options);
      throw new BandError({
        statusCode: 503,
        body: { error: { code: "service_unavailable", message: "Band is unavailable", request_id: "req-503" } },
      });
    };
    let seen: Record<string, unknown> | undefined;
    let relayed = true;
    const first = await startProcess(platform, journalDir, async ({ tools }) => {
      const bridge = createBandSdkMcpServer({ enableMemoryTools: false, getToolsForRoom: () => tools });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await bridge.serverConfig.instance.connect(serverTransport);
      const client = new Client({ name: "op-mcp-3", version: "1.0.0" });
      await client.connect(clientTransport);
      try {
        const result = await client.callTool({
          name: "band_send_message",
          arguments: { room_id: ROOM, content: "keyed unknown", mentions: [OWNER], operation_id: OP_ID },
        });
        expect(result.isError).toBe(true);
        seen = JSON.parse((result.content as Array<{ text: string }>)[0].text);
        relayed = await relayReply(tools, "unkeyed fallback", [OWNER]);
      } finally {
        await client.close();
      }
    });
    await settledAs(platform, inbound, "failed");
    expect(relayed).toBe(false);
    expect(seen).toEqual({ kind: DeliveryUnknownError.KIND, detail: unknownOperationMessage() });
    expect(postedContents(platform)).toEqual(["keyed unknown"]);
    const records = await recordsOf(journalDir);
    expect(records).toContain("op.unknown");
    expect(records).not.toContain("op.settled");
    // The next process's admission announces the unknown with its id.
    await first.runtime.stop(KILL);
    const second = await startProcess(platform, journalDir, async () => undefined);
    await until(() => reported(second.events).some(({ messageId, operationId }) => messageId === inbound && operationId === OP_ID));
    expect(reported(second.events).some(({ messageId, operationId }) => messageId === inbound && operationId === OP_ID)).toBe(true);
  }, 120000);

  it("routes a room-scoped tool to the call's room only: a keyed call from the wrong room stands refused", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    await platform.room(OTHER_ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} keyed please`);
    let wrongRoom: { thrown: boolean; isError: boolean; text: string } | undefined;
    let rightRoom: { thrown: boolean; isError: boolean; text: string } | undefined;
    await startProcess(platform, journalDir, async ({ tools }) => {
      // The bridge resolves each room to its own tools: room-2 has no live turn here.
      const bridge = createBandSdkMcpServer({
        enableMemoryTools: false,
        getToolsForRoom: (roomId: string) => (roomId === ROOM ? tools : undefined),
      });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await bridge.serverConfig.instance.connect(serverTransport);
      const client = new Client({ name: "op-mcp-4", version: "1.0.0" });
      await client.connect(clientTransport);
      try {
        // The turn stands in room-1; the call names room-2. A room-scoped tool
        // resolves its room from the turn, never from the call's argument.
        wrongRoom = await keyedCall(client, {
          room_id: OTHER_ROOM,
          content: "wrong room",
          mentions: [OWNER],
          operation_id: OP_ID,
        });
        rightRoom = await keyedCall(client, {
          room_id: ROOM,
          content: "right room",
          mentions: [OWNER],
          operation_id: OP_ID,
        });
      } finally {
        await client.close();
      }
    });
    await until(() => recordsContain(journalDir, "op.settled"));
    await settledAs(platform, inbound, "processed");
    expect(wrongRoom).toMatchObject({ isError: true });
    expect(wrongRoom?.text).toBeTruthy();
    expect(rightRoom).toMatchObject({ isError: false });
    expect(postedContents(platform, ROOM)).toEqual(["right room"]);
    expect(postedContents(platform, OTHER_ROOM)).toEqual([]);
    const otherRecords = await recordsOf(journalDir, OTHER_ROOM);
    expect(otherRecords).not.toContain("op.reserved");
  });

  it("does not fence an unrelated tool solely because it carries an operation_id field", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} unrelated id please`);
    let relayed: boolean | undefined;
    let unrelatedText = "";
    await startProcess(platform, journalDir, async ({ tools }) => {
      // A host tool that is not the canonical send or no-reply carries the
      // field on its own: it is not admitted, and the turn's reply stands.
      const bridge = createBandSdkMcpServer({
        enableMemoryTools: false,
        getToolsForRoom: () => tools,
        additionalTools: [
          {
            name: "not_a_band_publication_tool",
            description: "An unrelated tool that carries an operation_id of its own.",
            inputSchema: {
              type: "object",
              properties: { operation_id: { type: "string" } },
              required: ["operation_id"],
            },
            execute: async () => ({ content: [{ type: "text", text: "unrelated ran" }] }),
          },
        ],
      });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await bridge.serverConfig.instance.connect(serverTransport);
      const client = new Client({ name: "op-mcp-5", version: "1.0.0" });
      await client.connect(clientTransport);
      try {
        const result = await client.callTool({ name: "not_a_band_publication_tool", arguments: { operation_id: "unrelated" } });
        unrelatedText = (result.content as Array<{ text: string }>)[0]?.text ?? "";
        relayed = await relayReply(tools, "ordinary closing reply", [OWNER]);
      } finally {
        await client.close();
      }
    });
    await settledAs(platform, inbound, "processed");
    expect(unrelatedText).toBe("unrelated ran");
    // The unrelated call fenced nothing: the turn's closing text relayed.
    expect(relayed).toBe(true);
    expect(postedContents(platform, ROOM)).toEqual(["ordinary closing reply"]);
    const records = await recordsOf(journalDir);
    expect(records).not.toContain("op.reserved");
  });
});