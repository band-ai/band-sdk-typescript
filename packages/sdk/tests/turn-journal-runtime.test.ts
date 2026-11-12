import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { GenericAdapter, type GenericAdapterHandler } from "../src/adapters/GenericAdapter";
import type { AgentEvent } from "../src/contracts/events";
import { MS_PER_SECOND } from "../src/core/deadline";
import { createDeferred } from "../src/core/deferred";
import { ValidationError } from "../src/core/errors";
import { relayReply } from "../src/core/turn";
import { createBandSdkMcpServer } from "../src/mcp/sdk";
import { PlatformRuntime } from "../src/runtime";
import { agentJournalDir, RoomJournal, roomJournalFile, TurnJournal } from "../src/runtime/journal/TurnJournal";
import type { ContactEventConfig, SessionConfig } from "../src/runtime/types";
import { agentContactsTopic } from "@band-ai/band-sdk-core";
import { AGENT_API_KEY, AGENT_ID, BandPlatform, person } from "./flows/support/bandPlatform";
import { RecordLog, tmpRoot } from "./testUtils";
import { holdJournalAppend, interceptJournalAppends, recordTypes, RETENTION_MS } from "./turnJournalSupport";

const OWNER = "owner";
const ROOM = "room-1";
const OTHER_ROOM = "room-2";
const MENTION = `@[[${AGENT_ID}]]`;
/** A stop that waits for nothing: the process is killed with its turn and marks in flight. */
const KILL = 0;

type Handler = GenericAdapterHandler;

/**
 * One process of the agent: a runtime on `platform` journaling to `journalDir`,
 * or not journaling without one. Stopped when the test ends, if it still runs.
 */
async function startProcess(
  platform: BandPlatform,
  journalDir: string | undefined,
  handler: Handler,
  options: { sessionConfig?: Omit<SessionConfig, "journalDir">; contactConfig?: ContactEventConfig } = {},
) {
  const { sessionConfig = {}, contactConfig } = options;
  const handled: string[] = [];
  const events = new RecordLog<AgentEvent>();
  const runtime = new PlatformRuntime({
    agentId: AGENT_ID,
    apiKey: AGENT_API_KEY,
    linkOptions: platform.link,
    agentConfig: { autoSubscribeExistingRooms: true },
    sessionConfig: journalDir === undefined ? sessionConfig : { ...sessionConfig, journalDir },
    ...(contactConfig ? { contactConfig } : {}),
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

function journalFile(journalDir: string, roomId = ROOM): string {
  return roomJournalFile(agentJournalDir(journalDir, AGENT_ID), roomId);
}

function journalRecords(journalDir: string): Promise<string[]> {
  return recordTypes(journalFile(journalDir));
}

const reported = (events: RecordLog<AgentEvent>) => events.entries.filter((event) => event.type === "delivery.unrecorded");

/** Fails, as a full disk does, every journal append whose line matches `matches`; restored when the test ends. */
function failJournalAppends(matches: (line: string) => boolean): Promise<void> {
  return interceptJournalAppends((original, self, args) =>
    typeof args[0] === "string" && matches(args[0])
      ? Promise.reject(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }))
      : original.apply(self, args));
}

/** Resolves each time a room journal has really closed. */
function journalCloses(): RecordLog<RoomJournal> {
  const closed = new RecordLog<RoomJournal>();
  const close = RoomJournal.prototype.close;
  const spy = vi.spyOn(RoomJournal.prototype, "close").mockImplementation(async function (this: RoomJournal) {
    await close.call(this);
    closed.record(this);
  });
  onTestFinished(() => spy.mockRestore());
  return closed;
}

/** Each reply path, and the journal records its turn leaves. */
const replyPaths: Array<[string, Handler, string[]]> = [
  ["band_send_message", async ({ tools }) => {
    await tools.executeToolCall("band_send_message", { content: "answered", mentions: ["@owner"] });
  }, ["reply.intent", "turn.done"]],
  ["sendMessage", async ({ tools }) => {
    await tools.sendMessage("answered", ["@owner"]);
  }, ["reply.intent", "turn.done"]],
  ["the relayed closing text", async ({ tools }) => {
    await relayReply(tools, "answered", ["@owner"]);
  }, ["reply.intent", "turn.done"]],
  ["band_no_reply", async ({ tools }) => {
    await tools.executeToolCall("band_no_reply", { reason: "nothing to add" });
  }, ["turn.done"]],
  ["the in-process Band MCP server", async ({ tools }) => {
    // As the Claude SDK and ACP adapters reply: a Band MCP server resolving the room to the turn's tools.
    const bridge = createBandSdkMcpServer({ enableMemoryTools: false, getToolsForRoom: () => tools });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await bridge.serverConfig.instance.connect(serverTransport);
    const client = new Client({ name: "turn-journal-test", version: "1.0.0" });
    await client.connect(clientTransport);
    try {
      await client.callTool({ name: "band_send_message", arguments: { room_id: ROOM, content: "answered", mentions: ["@owner"] } });
    } finally {
      await client.close();
    }
  }, ["reply.intent", "turn.done"]],
];

/** A handler that posts `first`, then works until its process is killed. */
function repliesThenHangs(first: string) {
  const posted = createDeferred();
  const handler: Handler = async ({ tools }) => {
    await tools.sendMessage(first, ["@owner"]);
    posted.resolve();
    await new Promise<never>(() => undefined);
  };
  return { handler, posted: posted.promise };
}

describe("the turn journal across a restart", () => {
  it.each(replyPaths)("does not answer a message again whose turn replied through %s and ended before a restart beat its processed mark", async (_path, answer, recorded) => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} hello`);
    // The process dies after its turn ended, before Band hears the message was processed.
    const mark = platform.rest.processedHolds.hold((messageId) => messageId === inbound);
    const first = await startProcess(platform, journalDir, answer);
    await mark.sending;
    await first.runtime.stop(KILL);
    const postedBefore = room.posted.length;
    expect(await journalRecords(journalDir)).toEqual(recorded);

    const second = await startProcess(platform, journalDir, answer);

    expect(await room.outcome(inbound)).toBe("processed");
    expect(second.handled).toEqual([]);
    expect(room.posted).toHaveLength(postedBefore);
    expect(reported(second.events)).toEqual([]);
  });

  it("records the turn's end after all its replies and before the message is marked processed", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.executeToolCall("band_send_message", { content: "first", mentions: ["@owner"] });
      await tools.sendMessage("second", ["@owner"]);
    });
    const mark = room.holdNextProcessed();

    const inbound = await room.say(OWNER, `${MENTION} two answers please`);
    await mark.sending;

    expect(await journalRecords(journalDir)).toEqual(["reply.intent", "reply.intent", "turn.done"]);
    mark.release();
    expect(await room.outcome(inbound)).toBe("processed");
    expect(room.messages.map((posted) => posted.content)).toEqual(["first", "second"]);
  });

  it("answers a message again whose turn was killed midway, and reports once that its replies may repeat", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} two answers please`);
    const killed = repliesThenHangs("first");
    const first = await startProcess(platform, journalDir, killed.handler);
    await killed.posted;
    await first.runtime.stop(KILL);

    const second = await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.sendMessage("first", ["@owner"]);
      await tools.sendMessage("second", ["@owner"]);
    });
    await platform.rest.settled.next((settled) => settled.messageId === inbound && settled.outcome === "processed");

    expect(second.handled).toEqual([inbound]);
    // As without the journal, the re-run may repeat what the killed turn posted: it is reported.
    expect(room.messages.map((posted) => posted.content)).toEqual(["first", "first", "second"]);
    expect(reported(second.events)).toEqual([{ type: "delivery.unrecorded", roomId: ROOM, messageId: inbound }]);
    expect(await journalRecords(journalDir)).toEqual(["reply.intent", "replies.reported", "reply.intent", "reply.intent", "turn.done"]);
  });

  it("dispatches nothing for a message whose turn ended before a restart, and still bootstraps the next turn", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} hello`);
    const ended = new TurnJournal(journalDir, AGENT_ID, { retentionMs: RETENTION_MS });
    await (await ended.room(ROOM)).turnDone(inbound);
    await ended.close();

    const bootstraps: boolean[] = [];
    const { handled } = await startProcess(platform, journalDir, async ({ tools, isSessionBootstrap }) => {
      bootstraps.push(isSessionBootstrap);
      await tools.sendMessage("answered", ["@owner"]);
    });

    expect(await room.outcome(inbound)).toBe("processed");
    expect(handled).toEqual([]);
    // The skipped message did not use up the session's first turn: the next one still bootstraps it.
    const next = await room.say(OWNER, `${MENTION} again`);
    expect(await room.outcome(next)).toBe("processed");
    expect(bootstraps).toEqual([true]);
  });

  it("records an interrupted turn's end before its message is consumed", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const released = createDeferred();
    onTestFinished(() => released.resolve());
    const { events } = await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.sendMessage("partial", ["@owner"]);
      await released.promise;
    });
    const inbound = await room.say(OWNER, `${MENTION} hello`);
    await room.until(() => room.messages.length === 1);
    const mark = room.holdNextProcessed();

    platform.control("interrupt", ROOM);
    await mark.sending;

    expect(await journalRecords(journalDir)).toEqual(["reply.intent", "turn.done"]);
    mark.release();
    expect(await room.outcome(inbound)).toBe("processed");
    await events.next((event) => event.type === "turn.stopped");
  });

  it("records the end of a turn interrupted before it started, before its message is consumed", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} hello`);
    const claim = room.holdProcessing(inbound);
    const { handled } = await startProcess(platform, journalDir, async () => undefined);
    await claim.sending;

    platform.control("interrupt", ROOM);
    const mark = room.holdNextProcessed();
    claim.release();
    await mark.sending;

    expect(await journalRecords(journalDir)).toEqual(["turn.done"]);
    mark.release();
    expect(await room.outcome(inbound)).toBe("processed");
    expect(handled).toEqual([]);
  });

  it.each<[string, Handler]>([
    ["arguments that fail validation", async ({ tools }) => {
      await tools.executeToolCall("band_send_message", { content: "unaddressed", mentions: [] });
    }],
    ["a mention nobody in the room has", async ({ tools }) => {
      await tools.sendMessage("unaddressed", ["@nobody"]).catch(() => undefined);
    }],
  ])("records no reply for a send refused before its post, for %s", async (_refusal, refuse) => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    await startProcess(platform, journalDir, async (args) => {
      await refuse(args);
      await args.tools.sendMessage("answered", ["@owner"]);
    });

    expect(await room.outcome(await room.say(OWNER, `${MENTION} hello`))).toBe("processed");

    expect(room.messages.map((posted) => posted.content)).toEqual(["answered"]);
    expect(await journalRecords(journalDir)).toEqual(["reply.intent", "turn.done"]);
  });

  it("does not post a reply whose turn is interrupted while its record is written", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const append = await holdJournalAppend((line) => line.includes('"t":"reply.intent"'));
    const sent = createDeferred<unknown>();
    const { events } = await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.sendMessage("late", ["@owner"]).then(sent.resolve, sent.resolve);
    });
    const inbound = await room.say(OWNER, `${MENTION} hello`);
    await append.entered;

    platform.control("interrupt", ROOM);
    await events.next((event) => event.type === "turn.stopped");
    append.release();

    expect(await sent.promise).toMatchObject({ message: expect.stringContaining("This turn was cut short") });
    expect(await room.outcome(inbound)).toBe("processed");
    expect(room.messages).toEqual([]);
  });
});

describe("the turn journal when Band serves a message again", () => {
  it("runs a message again after a restart when its turn replied and then failed, as without the journal", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} hello`);
    // The process dies after marking the turn failed, before it gives up on the message.
    const giveUp = platform.rest.processedHolds.hold((messageId) => messageId === inbound);
    const first = await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.sendMessage("partial", ["@owner"]);
      throw new Error("the model call failed");
    });
    expect(await room.outcome(inbound)).toBe("failed");
    await giveUp.sending;
    await first.runtime.stop(KILL);
    expect(await journalRecords(journalDir)).toEqual(["reply.intent"]);

    const second = await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.sendMessage("answered", ["@owner"]);
    });

    await platform.rest.settled.next((settled) => settled.messageId === inbound && settled.outcome === "processed");
    expect(room.outcomes(inbound)).toEqual(["failed", "processed"]);
    expect(second.handled).toEqual([inbound]);
    expect(room.messages.map((posted) => posted.content)).toEqual(["partial", "answered"]);
    expect(reported(second.events)).toEqual([{ type: "delivery.unrecorded", roomId: ROOM, messageId: inbound }]);
    expect(await journalRecords(journalDir)).toEqual(["reply.intent", "replies.reported", "reply.intent", "turn.done"]);
  });

  it("runs a stopped turn's message again on play, though the stopped turn had replied", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const released = createDeferred();
    onTestFinished(() => released.resolve());
    let turns = 0;
    const journalDir = tmpRoot();
    const refused = createDeferred<unknown>();
    const { handled, events } = await startProcess(platform, journalDir, async ({ tools }) => {
      turns += 1;
      if (turns === 1) {
        await tools.sendMessage("partial", ["@owner"]);
        await released.promise;
        // Cut short: this reply is refused and records nothing.
        await tools.sendMessage("late", ["@owner"]).then(refused.resolve, refused.resolve);
        return;
      }
      await tools.sendMessage("answered", ["@owner"]);
    });
    const inbound = await room.say(OWNER, `${MENTION} hello`);
    await room.until(() => room.messages.length === 1);

    platform.control("stop", ROOM);
    await events.next((event) => event.type === "turn.stopped");
    released.resolve();
    await refused.promise;
    platform.control("play", ROOM);

    expect(await room.outcome(inbound)).toBe("processed");
    expect(handled).toEqual([inbound, inbound]);
    expect(room.messages.map((posted) => posted.content)).toEqual(["partial", "answered"]);
    expect(reported(events)).toEqual([{ type: "delivery.unrecorded", roomId: ROOM, messageId: inbound }]);
    expect(await journalRecords(journalDir)).toEqual(["reply.intent", "replies.reported", "reply.intent", "turn.done"]);
  });

});

describe("the turn journal while a room's handling stops and starts", () => {
  it("records the replies of a turn that outlives its room's reset, so the repeat is reported", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const keepWorking = createDeferred();
    onTestFinished(() => keepWorking.resolve());
    const lateSent = createDeferred<unknown>();
    let turns = 0;
    const { runtime, events, handled } = await startProcess(platform, tmpRoot(), async ({ tools }) => {
      turns += 1;
      if (turns === 1) {
        // An adapter that cannot be cancelled keeps working past the reset's budget.
        await keepWorking.promise;
        await tools.sendMessage("late", ["@owner"]).then(lateSent.resolve, lateSent.resolve);
        return;
      }
      await tools.sendMessage("again", ["@owner"]);
    });
    const inbound = await room.say(OWNER, `${MENTION} hello`);
    await events.next((event) => event.type === "turn.started");

    expect(await runtime.resetRoomSession(ROOM, 1)).toBe(false);
    await events.next((event) => event.type === "room.stopped");
    keepWorking.resolve();
    await lateSent.promise;
    const next = await room.say(OWNER, `${MENTION} next`);
    await room.until(() => handled.filter((id) => id === inbound).length === 2);

    expect(await room.outcome(next)).toBe("processed");
    expect(await room.outcome(inbound)).toBe("processed");
    expect(room.messages.map((posted) => posted.content)).toEqual(["late", "again", "again"]);
    expect(reported(events)).toEqual([{ type: "delivery.unrecorded", roomId: ROOM, messageId: inbound }]);
  });

  it("settles a finished message Band serves again after its room was left and rejoined, without running it", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const { handled, events } = await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.sendMessage("answered", ["@owner"]);
    });
    const closed = journalCloses();
    const opened = vi.spyOn(RoomJournal, "open");
    onTestFinished(() => opened.mockRestore());
    // The turn finishes but Band never hears it was processed.
    const mark = room.holdNextProcessed({ error: new Error("503 from Band") });
    const inbound = await room.say(OWNER, `${MENTION} hello`);
    await mark.sending;
    mark.release();
    await room.remove();
    await events.next((event) => event.type === "room.stopped");
    // Left, the room holds no file open.
    await closed.next(() => true);
    expect(opened).toHaveBeenCalledTimes(1);

    const rejoined = await platform.room(ROOM);
    await platform.rest.settled.next((settled) => settled.messageId === inbound && settled.outcome === "processed");

    expect(handled).toEqual([inbound]);
    expect(opened).toHaveBeenCalledTimes(2);
    expect(rejoined.messages.map((posted) => posted.content)).toEqual(["answered"]);
    expect(await journalRecords(journalDir)).toEqual(["reply.intent", "turn.done"]);
  });

  it("settles an interrupted message whose room was left meanwhile without writing to the released journal", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} hello`);
    const opening = createDeferred();
    const openStarted = createDeferred();
    const openRoom = RoomJournal.open.bind(RoomJournal);
    const open = vi.spyOn(RoomJournal, "open").mockImplementationOnce(async (...args) => {
      openStarted.resolve();
      await opening.promise;
      return openRoom(...args);
    });
    const turnDone = vi.spyOn(RoomJournal.prototype, "turnDone");
    onTestFinished(() => {
      open.mockRestore();
      turnDone.mockRestore();
    });
    const claim = room.holdProcessing(inbound);
    const { handled, events } = await startProcess(platform, tmpRoot(), async () => undefined);
    await openStarted.promise;

    // Interrupted before it was claimed, then the claim is held while the room is left.
    platform.control("interrupt", ROOM);
    opening.resolve();
    await claim.sending;
    await room.remove();
    await events.next((event) => event.type === "room.stopped");
    claim.release();

    expect(await room.outcome(inbound)).toBe("processed");
    expect(handled).toEqual([]);
    expect(turnDone).not.toHaveBeenCalled();
  });

  it("opens no journal for a reply a turn makes after the runtime stopped waiting on it, and posts it", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const keepWorking = createDeferred();
    onTestFinished(() => keepWorking.resolve());
    const sent = createDeferred<unknown>();
    const { runtime, events } = await startProcess(platform, tmpRoot(), async ({ tools }) => {
      await keepWorking.promise;
      await tools.sendMessage("late", ["@owner"]).then(sent.resolve, sent.resolve);
    });
    await room.say(OWNER, `${MENTION} hello`);
    await events.next((event) => event.type === "turn.started");
    expect(await runtime.stop(KILL)).toBe(false);
    const opened = vi.spyOn(RoomJournal, "open");
    onTestFinished(() => opened.mockRestore());

    keepWorking.resolve();
    await sent.promise;

    expect(opened).not.toHaveBeenCalled();
    expect(room.messages.map((posted) => posted.content)).toEqual(["late"]);
  });

  it("opens no journal for a synthetic contact-hub turn, stopped and replayed", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const journalDir = tmpRoot();
    const released = createDeferred();
    onTestFinished(() => released.resolve());
    let turns = 0;
    const { handled, events } = await startProcess(platform, journalDir, async ({ tools }) => {
      turns += 1;
      if (turns === 1) await released.promise;
      tools.turn.settle();
    }, { contactConfig: { strategy: "hub_room", hubTaskId: "contacts" } });
    await platform.transport.emit(agentContactsTopic(AGENT_ID), "contact_request_received", {
      id: "request-1", from_handle: "alice", from_name: "alice", message: "Hello", status: "pending", inserted_at: new Date().toISOString(),
    });
    const started = await events.next((event) => event.type === "turn.started");
    if (started.type !== "turn.started") throw new Error("expected the hub turn to start");

    platform.control("stop", started.roomId);
    await events.next((event) => event.type === "turn.stopped");
    released.resolve();
    platform.control("play", started.roomId);
    const ended = await events.next((event) => event.type === "turn.completed" || event.type === "turn.failed");

    expect(ended.type).toBe("turn.completed");

    expect(handled).toEqual([started.messageId, started.messageId]);
    expect(reported(events)).toEqual([]);
    expect(await readdir(agentJournalDir(journalDir, AGENT_ID))).toEqual([]);
  });
});

describe("a turn journal that fails", () => {
  it("fails start when journalDir is not a usable directory", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    await platform.room(ROOM);
    const file = path.join(tmpRoot(), "journal");
    await writeFile(file, "not a directory");

    await expect(startProcess(platform, file, async () => undefined)).rejects.toBeInstanceOf(ValidationError);
  });

  it.each([
    ["a room's journal", RoomJournal.prototype],
    ["the journal", TurnJournal.prototype],
  ] as const)("stops cleanly when %s fails to close", async (_which, owner) => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const { runtime } = await startProcess(platform, tmpRoot(), async ({ tools }) => {
      await tools.sendMessage("answered", ["@owner"]);
    });
    expect(await room.outcome(await room.say(OWNER, `${MENTION} hello`))).toBe("processed");
    const close = vi.spyOn(owner, "close").mockRejectedValueOnce(new Error("EIO: i/o error, close"));
    onTestFinished(() => close.mockRestore());

    expect(await runtime.stop()).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(runtime.state.status).toBe("stopped");
  });

  it("handles a turn without the journal when its room's journal cannot be opened, and uses it once it can be", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const other = await platform.room(OTHER_ROOM);
    const journalDir = tmpRoot();
    // The room's journal path is taken by a directory: opening it fails.
    await mkdir(journalFile(journalDir), { recursive: true });
    const bootstraps: boolean[] = [];
    const { runtime, handled } = await startProcess(platform, journalDir, async ({ tools, isSessionBootstrap, roomId }) => {
      if (roomId === ROOM) bootstraps.push(isSessionBootstrap);
      await tools.sendMessage("answered", ["@owner"]);
    });

    const unjournaled = await room.say(OWNER, `${MENTION} one`);
    expect(await room.outcome(unjournaled)).toBe("processed");
    const fine = await other.say(OWNER, `${MENTION} hello`);
    expect(await other.outcome(fine)).toBe("processed");
    await rm(journalFile(journalDir), { recursive: true });
    const journaled = await room.say(OWNER, `${MENTION} two`);
    expect(await room.outcome(journaled)).toBe("processed");

    expect(handled).toEqual([unjournaled, fine, journaled]);
    expect(bootstraps).toEqual([true, false]);
    expect(runtime.state.status).toBe("running");
    expect(await journalRecords(journalDir)).toEqual(["reply.intent", "turn.done"]);
  });

  it("still posts a reply and settles its message when the journal cannot record either", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    await failJournalAppends((line) => line.includes('"t":"reply.intent"') || line.includes('"t":"turn.done"'));
    const { runtime } = await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.sendMessage("answered", ["@owner"]);
    });

    expect(await room.outcome(await room.say(OWNER, `${MENTION} hello`))).toBe("processed");

    expect(room.messages.map((posted) => posted.content)).toEqual(["answered"]);
    expect(await journalRecords(journalDir)).toEqual([]);
    expect(runtime.state.status).toBe("running");
  });

  it("still answers a message again when its repeat report cannot be recorded", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} hello`);
    const crashed = new TurnJournal(journalDir, AGENT_ID, { retentionMs: RETENTION_MS });
    await (await crashed.room(ROOM)).replyBegun(inbound);
    await crashed.close();
    await failJournalAppends((line) => line.includes('"t":"replies.reported"'));

    const { handled, events } = await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.sendMessage("answered", ["@owner"]);
    });

    expect(await room.outcome(inbound)).toBe("processed");
    expect(handled).toEqual([inbound]);
    expect(reported(events)).toEqual([{ type: "delivery.unrecorded", roomId: ROOM, messageId: inbound }]);
  });

  it.each([
    ["is still settled without a turn exactly", 60 * MS_PER_SECOND, false],
    ["runs again one millisecond past", 60 * MS_PER_SECOND + 1, true],
  ] as const)("a message whose turn ended %s journalRetentionSeconds after its last record", async (_when, elapsedMs, runsAgain) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const ended = new TurnJournal(journalDir, AGENT_ID, { retentionMs: RETENTION_MS });
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} hello`);
    await (await ended.room(ROOM)).turnDone(inbound);
    await ended.close();
    vi.advanceTimersByTime(elapsedMs);

    const { handled } = await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.sendMessage("answered", ["@owner"]);
    }, { sessionConfig: { journalRetentionSeconds: 60 } });

    expect(await room.outcome(inbound)).toBe("processed");
    expect(handled).toEqual(runsAgain ? [inbound] : []);
  });
});
