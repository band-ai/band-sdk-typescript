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

async function startProcess(
  platform: BandPlatform,
  journalDir: string,
  handler: Handler,
  options: { sessionConfig?: Omit<SessionConfig, "journalDir"> } = {},
) {
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
  onTestFinished(async () => {
    if (runtime.state.status === "running") await runtime.stop(KILL);
  });
  await runtime.start(
    new GenericAdapter(async (args) => {
      handled.push(String(args.message.id));
      await handler(args);
    }),
  );
  return { runtime, handled, events };
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
    expect(platform.rest.posted.entries.filter(({ messageType }) => messageType !== "error").map(({ content }) => content)).toEqual([
      "keyed lost",
    ]);

    const seen: unknown[] = [];
    let relayed = true;
    const second = await startProcess(platform, journalDir, async (args) => {
      const { tools } = args;
      // The successor turn is unaffected by the old operation: it answers plainly.
      if (String(args.message.content).includes("next")) {
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
        expect(retry.isError).toBe(true);
        seen.push(JSON.parse((retry.content as Array<{ text: string }>)[0].text));
        // The turn is fenced: no unkeyed replacement may stand in it.
        relayed = await relayReply(tools, "unkeyed fallback", [OWNER]);
      } finally {
        await client.close();
      }
    });
    await settledAs(platform, inbound, "failed");
    expect(relayed).toBe(false);
    expect(
      platform.rest.posted.entries.filter(({ messageType }) => messageType !== "error").map(({ content }) => content),
    ).toEqual(["keyed lost"]);
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
    expect(
      platform.rest.posted.entries.filter(({ messageType }) => messageType !== "error").map(({ content }) => content),
    ).toEqual(["keyed lost", "next answered"]);
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
    expect(platform.rest.posted.entries.filter(({ messageType }) => messageType !== "error")).toEqual([]);

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
        expect(result.isError).toBeUndefined();
      } finally {
        await client.close();
      }
    });
    await until(() => recordsContain(journalDir, "op.settled"));
    // The provably unposted operation was never announced on either admission.
    expect(reported(second.events)).toEqual([]);
    // The same id re-ran: it posted once and settled.
    expect(
      platform.rest.posted.entries.filter(({ messageType }) => messageType !== "error").map(({ content }) => content),
    ).toEqual(["pending never posted"]);
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
    let declinedSecond: unknown;
    await startProcess(platform, journalDir, async ({ tools }) => {
      const first = await tools.executeToolCall("band_no_reply", { room_id: ROOM, reason: "fyi only", operation_id: OP_ID });
      expect(first).toEqual({ status: "ok" });
      declinedSecond = await tools.executeToolCall("band_no_reply", { room_id: ROOM, reason: "fyi only", operation_id: OP_ID });
    });
    await until(() => recordsContain(journalDir, "decline.settled"));
    await settledAs(platform, inbound, "processed");
    expect(platform.rest.posted.entries).toEqual([]);
    expect(platform.rest.deliveries).toEqual([]);
    expect(declinedSecond).toEqual({ status: "ok" });
    expect(await recordsOf(journalDir)).toEqual(["op.reserved", "op.settled", "decline.settled", "decline.settled", "turn.done"]);
  });

  it("takes a changed payload over a direct sendMessage option to conflict before any post", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} direct keyed please`);
    let conflict: unknown;
    let handlerDone = false;
    const first = await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.sendMessage("direct keyed", [OWNER], { operationId: OP_ID });
      conflict = await tools.sendMessage("direct changed", [OWNER], { operationId: OP_ID }).catch((error) => error);
      expect(conflict).toBeInstanceOf(DeliveryFailedError);
      expect((conflict as DeliveryFailedError).cause).toBeInstanceOf(OperationConflictError);
      handlerDone = true;
    });
    // The conflict is judged against the live journal: the stop waits for the
    // handler's second call to run before it lands.
    await until(() => handlerDone);
    // The conflict stands refused: one post, the changed content never ran.
    expect(
      platform.rest.posted.entries.filter(({ messageType }) => messageType !== "error").map(({ content }) => content),
    ).toEqual(["direct keyed"]);
    await first.runtime.stop(KILL);
    // The successful keyed send durably settled this caller's captured inbound.
    await settledAs(platform, inbound, "processed");
    // A same-id call on a later process joins the standing refusal: it runs
    // nothing and posts nothing. The new process subscribes first, so the
    // message reaches it live.
    const retry = await startProcess(platform, journalDir, async ({ tools }) => {
      const replay = await tools.sendMessage("direct keyed", [OWNER], { operationId: OP_ID }).catch((error) => error);
      expect(replay).toBeInstanceOf(DeliveryFailedError);
      expect((replay as DeliveryFailedError).cause).toBeInstanceOf(Error);
      expect((replay as DeliveryFailedError).cause as Error).toHaveProperty("name", "OperationRefusedError");
    });
    await room.say(OWNER, `${MENTION} retry please`);
    await until(async () => retry.handled.length >= 1);
    // The retry joins the stored refusal: no second post.
    expect(
      platform.rest.posted.entries.filter(({ messageType }) => messageType !== "error").map(({ content }) => content),
    ).toEqual(["direct keyed"]);
    expect(conflict).toBeInstanceOf(DeliveryFailedError);
    expect((conflict as DeliveryFailedError).cause).toBeInstanceOf(OperationConflictError);
  });

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
    expect(refused).toMatchObject({ errorType: "ToolExecutionError" });
    // The refusal stands before any durable operation: no record, and the keyed
    // content never stands; the turn's own failure notice is the runtime's, not the operation's.
    const records = await recordsOf(journalDir);
    expect(records).not.toContain("op.reserved");
    expect(platform.rest.posted.entries.filter(({ messageType }) => messageType !== "error")).toEqual([]);
    // A later turn on the same backend refuses the same way: no inference from history.
    await first.runtime.stop(KILL);
    await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.executeToolCall("band_send_message", {
        room_id: ROOM,
        content: "cannot stand",
        mentions: [OWNER],
        operation_id: OP_ID,
      });
    });
    const again = await room.say(OWNER, `${MENTION} keyed again`);
    await settledAs(platform, again, "failed");
    expect(platform.rest.posted.entries.filter(({ messageType }) => messageType !== "error")).toEqual([]);
    const recordsAgain = await recordsOf(journalDir);
    expect(recordsAgain).not.toContain("op.reserved");
  }, 180000);
});

describe("the MCP bridge's keyed admission", () => {
  async function keyedCall(client: Client, arguments_: Record<string, unknown>) {
    try {
      const result = await client.callTool({ name: "band_send_message", arguments: arguments_ });
      return { thrown: false as const, result };
    } catch (error) {
      return { thrown: true as const, text: error instanceof Error ? error.message : String(error) };
    }
  }

  it("fences a turn on a schema-invalid operation id before any business runs, and leaves an unrelated room unfenced", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const otherRoom = await platform.room(OTHER_ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} keyed please`);
    const otherInbound = otherRoom.postBeforeConnect(OWNER, `${MENTION} other room please`);

    let fenced: unknown;
    let otherRelayed = false;
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
        const invalid = await keyedCall(client, { room_id: ROOM, content: "x", mentions: [OWNER], operation_id: 123 });
        if (invalid.thrown) {
          expect(invalid.text).toBeTruthy();
        } else {
          expect(invalid.result.isError).toBe(true);
          expect((invalid.result.content as Array<{ text: string }>)[0].text).toBeTruthy();
        }
        // The turn is fenced on admission: an unkeyed closing relay stands nowhere.
        fenced = await relayReply(tools, "unkeyed fallback", [OWNER]);
      } finally {
        await client.close();
      }
    });
    await settledAs(platform, inbound, "failed");
    expect(fenced).toBe(false);
    // Nothing unkeyed stands in the fenced room: only its failure notice.
    expect(platform.rest.posted.entries.filter(({ roomId, messageType }) => roomId === ROOM && messageType !== "error")).toEqual([]);
    // The fence stands for the turn that admitted the bad call: nothing unkeyed was posted for it.
    await settledAs(platform, otherInbound, "processed");
    expect(otherRelayed).toBe(true);
    expect(platform.rest.posted.entries.filter(({ roomId }) => roomId === OTHER_ROOM).map(({ content }) => content)).toEqual([
      "other room answered",
    ]);
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
    const outcomes: Array<Record<string, unknown>> = [];
    await startProcess(platform, journalDir, async ({ tools }) => {
      const bridge = createBandSdkMcpServer({ enableMemoryTools: false, getToolsForRoom: () => tools });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await bridge.serverConfig.instance.connect(serverTransport);
      const client = new Client({ name: "op-mcp-2", version: "1.0.0" });
      await client.connect(clientTransport);
      try {
        // The id stands; content is not a string. The schema refuses the call; the
        // id still fenced the turn at admission.
        const invalid = await keyedCall(client, {
          room_id: ROOM,
          content: 42,
          mentions: [OWNER],
          operation_id: OP_ID,
        });
        outcomes.push(invalid);
        const keyed = await keyedCall(client, {
          room_id: ROOM,
          content: "keyed through bridge",
          mentions: [OWNER],
          operation_id: OP_ID,
        });
        outcomes.push(keyed);
        // A same-id retry in the same turn joins the stored result.
        const replay = await keyedCall(client, {
          room_id: ROOM,
          content: "keyed through bridge",
          mentions: [OWNER],
          operation_id: OP_ID,
        });
        outcomes.push(replay);
        const relayed = await relayReply(tools, "unkeyed after", [OWNER]);
        expect(relayed).toBe(false);
      } finally {
        await client.close();
      }
    });
    await until(() => recordsContain(journalDir, "op.settled"));
    await settledAs(platform, inbound, "processed");
    expect(platform.rest.posted.entries.filter(({ roomId }) => roomId === ROOM).map(({ content }) => content)).toEqual([
      "keyed through bridge",
    ]);
    // The invalid call was refused with a nonempty schema error; the keyed call and
    // its replay both stood without a second post.
    const [invalid, keyed, replay] = outcomes;
    expect(invalid).toMatchObject({ thrown: false });
    expect((invalid as { result: { isError: boolean; content: Array<{ text: string }> } }).result.isError).toBe(true);
    expect((invalid as { result: { content: Array<{ text: string }> } }).result.content[0].text).toBeTruthy();
    expect(keyed).toMatchObject({ thrown: false });
    expect((keyed as { result: { isError?: boolean } }).result.isError).toBeUndefined();
    expect(replay).toMatchObject({ thrown: false });
    expect((replay as { result: { isError?: boolean } }).result.isError).toBeUndefined();
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
    let seen: unknown;
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
    expect(
      platform.rest.posted.entries.filter(({ messageType }) => messageType !== "error").map(({ content }) => content),
    ).toEqual(["keyed unknown"]);
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
    let wrongRoom: unknown;
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
        wrongRoom = await client.callTool({
          name: "band_send_message",
          arguments: { room_id: OTHER_ROOM, content: "wrong room", mentions: [OWNER], operation_id: OP_ID },
        });
        expect((wrongRoom as { isError?: boolean }).isError).toBe(true);
        const ok = await client.callTool({
          name: "band_send_message",
          arguments: { room_id: ROOM, content: "right room", mentions: [OWNER], operation_id: OP_ID },
        });
        expect(ok.isError).toBeUndefined();
      } finally {
        await client.close();
      }
    });
    await until(() => recordsContain(journalDir, "op.settled"));
    await settledAs(platform, inbound, "processed");
    expect(platform.rest.posted.entries.filter(({ roomId }) => roomId === ROOM).map(({ content }) => content)).toEqual(["right room"]);
    expect(platform.rest.posted.entries.filter(({ roomId }) => roomId === OTHER_ROOM)).toEqual([]);
    const otherRecords = await recordsOf(journalDir, OTHER_ROOM);
    expect(otherRecords).not.toContain("op.reserved");
  });
});