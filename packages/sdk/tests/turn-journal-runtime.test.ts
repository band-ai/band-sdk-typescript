import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BandError } from "@band-ai/rest-client";

import { describe, expect, it, onTestFinished, vi } from "vitest";

import { GenericAdapter, type GenericAdapterHandler } from "../src/adapters/GenericAdapter";
import { runUntilReleased } from "../src/adapters/shared/runUntilReleased";
import type { AgentEvent } from "../src/contracts/events";
import { createDeferred } from "../src/core/deferred";
import { ValidationError } from "../src/core/errors";
import { NoopLogger } from "../src/core/logger";
import { relayReply } from "../src/core/turn";
import { createBandSdkMcpServer } from "../src/mcp/sdk";
import { PlatformRuntime } from "../src/runtime";
import { identityDirectoryComponent } from "../src/runtime/journal/records";
import { TurnJournal, agentJournalDir } from "../src/runtime/journal/TurnJournal";
import { RoomJournal } from "../src/runtime/journal/RoomJournal";
import { JournalOwnershipError } from "../src/runtime/journal/ownership";
import type { ContactEventConfig, SessionConfig } from "../src/runtime/types";
import { agentContactsTopic } from "@band-ai/band-sdk-core";
import { AGENT_API_KEY, AGENT_ID, BandPlatform, person } from "./flows/support/bandPlatform";
import { RecordLog, tmpRoot, type HeldCall } from "./testUtils";
import { IDENTITY, diskFull, holdJournalAppend, interceptJournalAppends, journalLines, recordTypes, roomFile } from "./turnJournalSupport";

const OWNER = "owner";
const ROOM = "room-1";
const OTHER_ROOM = "room-2";
const MENTION = `@[[${AGENT_ID}]]`;
/** A stop that waits for nothing: the process is killed with its turn and marks in flight. */
const KILL = 0;

type Handler = GenericAdapterHandler;

/**
 * One process of the agent: a runtime on `platform` journaling to `journalDir`
 * under the platform's attested identity, or not journaling without one.
 * Stopped when the test ends, if it still runs.
 */
async function startProcess(
  platform: BandPlatform,
  journalDir: string | undefined,
  handler: Handler,
  options: { sessionConfig?: Omit<SessionConfig, "journalDir">; contactConfig?: ContactEventConfig; withIdentity?: boolean } = {},
) {
  const { sessionConfig = {}, contactConfig, withIdentity = true } = options;
  const handled: string[] = [];
  const events = new RecordLog<AgentEvent>();
  const runtime = new PlatformRuntime({
    agentId: AGENT_ID,
    apiKey: AGENT_API_KEY,
    linkOptions: platform.link,
    agentConfig: { autoSubscribeExistingRooms: true },
    sessionConfig:
      journalDir === undefined
        ? sessionConfig
        : {
            ...sessionConfig,
            journalDir,
            journalPlatformIdentity:
              sessionConfig.journalPlatformIdentity ?? (withIdentity ? IDENTITY : undefined),
          },
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

function journalFile(journalDir: string, roomId: string = ROOM): string {
  return roomFile(journalDir, IDENTITY, AGENT_ID, roomId);
}

function journalRecords(journalDir: string, roomId: string = ROOM): Promise<string[]> {
  return recordTypes(journalFile(journalDir, roomId));
}

const reported = (events: RecordLog<AgentEvent>) => events.entries.filter((event) => event.type === "delivery.unrecorded");

/** Fails, as a full disk does, every journal append whose line matches `matches`; restored when the test ends. */
function failJournalAppends(matches: (line: string) => boolean): Promise<void> {
  return interceptJournalAppends((original, self, args) =>
    typeof args[0] === "string" && matches(args[0])
      ? Promise.reject(diskFull())
      : original.apply(self, args));
}

/** One agent's journal seeded directly: what `seed` writes under the identity, owned by no process. */
async function seedRoomRecords(journalDir: string, roomId: string, seed: (room: RoomJournal) => Promise<unknown> | unknown): Promise<void> {
  const journals = new TurnJournal(journalDir, AGENT_ID);
  const generation = await journals.activate(IDENTITY);
  const room = await generation.room(roomId);
  await seed(room);
  await generation.close();
}

/** Each reply path, and the journal records its turn leaves. */
const replyPaths: Array<[string, Handler, string[]]> = [
  ["band_send_message", async ({ tools }) => {
    await tools.executeToolCall("band_send_message", { content: "answered", mentions: ["@owner"] });
  }, ["reply.intent", "reply.settled", "turn.done"]],
  ["sendMessage", async ({ tools }) => {
    await tools.sendMessage("answered", ["@owner"]);
  }, ["reply.intent", "reply.settled", "turn.done"]],
  ["the relayed closing text", async ({ tools }) => {
    await relayReply(tools, "answered", ["@owner"]);
  }, ["reply.intent", "reply.settled", "turn.done"]],
  ["band_no_reply", async ({ tools }) => {
    await tools.executeToolCall("band_no_reply", { reason: "nothing to add" });
  }, ["decline.settled", "turn.done"]],
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
  }, ["reply.intent", "reply.settled", "turn.done"]],
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

    expect(await journalRecords(journalDir)).toEqual(["reply.intent", "reply.settled", "reply.intent", "reply.settled", "turn.done"]);
    mark.release();
    expect(await room.outcome(inbound)).toBe("processed");
    expect(room.messages.map((posted) => posted.content)).toEqual(["first", "second"]);
  });

  it("settles a killed midway turn's message from its settled reply, without running its adapter again", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} two answers please`);
    const killed = repliesThenHangs("first");
    const first = await startProcess(platform, journalDir, killed.handler);
    await killed.posted;
    await first.runtime.stop(KILL);
    // The posted reply is settled durably: it stands, and it settles the message. The
    // turn's end is not recorded, but the settlement is what a restart suppresses on.
    expect(await journalRecords(journalDir)).toEqual(["reply.intent", "reply.settled"]);

    const second = await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.sendMessage("first", ["@owner"]);
      await tools.sendMessage("second", ["@owner"]);
    });

    expect(await room.outcome(inbound)).toBe("processed");
    // The first settled reply marks the inbound answered: the adapter is not run again,
    // and it posts nothing — no repeat of "first", no "second".
    expect(second.handled).toEqual([]);
    expect(room.messages.map((posted) => posted.content)).toEqual(["first"]);
    expect(reported(second.events)).toEqual([]);
    expect(await journalRecords(journalDir)).toEqual(["reply.intent", "reply.settled"]);
  });

  it("dispatches nothing for a message whose turn ended before a restart, and still bootstraps the next turn", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} hello`);
    await seedRoomRecords(journalDir, ROOM, (room) => room.turnDone(inbound));

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

    expect(await journalRecords(journalDir)).toEqual(["reply.intent", "reply.settled", "turn.done"]);
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

  it("records no reply for a send refused before its post by validation, and a refusal for one the platform never took", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    await startProcess(platform, journalDir, async (args) => {
      // Empty mentions fail the call's validation before any publication begins.
      await args.tools.executeToolCall("band_send_message", { content: "unaddressed", mentions: [] });
      // A mention the room has is resolved against the roster, which the platform refuses;
      // the publication is recorded refused, and the room keeps admitting records.
      await args.tools.sendMessage("unaddressed", ["@nobody"]).catch(() => undefined);
      await args.tools.sendMessage("answered", ["@owner"]);
    });

    expect(await room.outcome(await room.say(OWNER, `${MENTION} hello`))).toBe("processed");

    expect(room.messages.map((posted) => posted.content)).toEqual(["answered"]);
    expect(await journalRecords(journalDir)).toEqual(["reply.intent", "reply.refused", "reply.intent", "reply.settled", "turn.done"]);
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

    // The turn was cut short after its intent stood: the reply is refused, and its
    // refusal is recorded. Its message is settled and consumed with its turn's end.
    const error = await sent.promise;
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("cut short");
    expect(await room.outcome(inbound)).toBe("processed");
    expect(room.messages).toEqual([]);
    expect(await journalRecords(journalDir)).toEqual(["reply.intent", "turn.done", "reply.refused"]);
  });
});

describe("an unresolved publication through a restart", () => {
  it("recovers a durably settled reply's message without calls, and reports the one whose delivery stands unknown", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const a = room.postBeforeConnect(OWNER, `${MENTION} hello A`);
    const b = room.postBeforeConnect(OWNER, `${MENTION} hello B`);
    // The platform answers B's post with 503: it may hold the reply, and cannot say.
    const posts: string[] = [];
    const original = platform.rest.createChatMessage.bind(platform.rest);
    const spy = vi.spyOn(platform.rest, "createChatMessage").mockImplementation(async (roomId, message, options) => {
      posts.push(message.content);
      if (message.content === "answer B") {
        throw new BandError({ statusCode: 503, body: { error: { code: "server_error", message: "Service unavailable", request_id: "req-1" } } });
      }
      return original(roomId, message, options);
    });
    onTestFinished(() => spy.mockRestore());

    let relayed = true;
    const first = await startProcess(platform, journalDir, async ({ tools, message }) => {
      const isB = message.content.includes("B");
      await tools.sendMessage(isB ? "answer B" : "answer A", ["@owner"]).catch(() => undefined);
      if (isB) {
        // The turn's own closing text must not go out as a replacement for the unknown reply.
        relayed = await relayReply(tools, "closing text", ["@owner"]);
      }
    });
    await platform.rest.settled.next((settled) => settled.messageId === a && settled.outcome === "processed");
    await platform.rest.settled.next((settled) => settled.messageId === b && settled.outcome === "failed");
    expect(relayed).toBe(false);
    // B's unknown reply is fenced: the platform took answer A and answer B's attempt, nothing else.
    expect(posts).toEqual(["answer A", "answer B"]);
    expect(room.failureLabels(b)).toEqual([expect.stringContaining("delivery is unknown")]);
    await first.runtime.stop(KILL);
    expect(await journalRecords(journalDir)).toEqual([
      "reply.intent", "reply.settled", "turn.done", // A: settled, its turn ended, its mark landed.
      "reply.intent", "reply.unknown", // B: delivery unknown, its turn failed.
    ]);

    const second = await startProcess(platform, journalDir, async ({ tools }) => {
      void tools;
    });
    const postedBeforeRestart = posts.length;

    // A: settled before the process died — Band holds its processed mark, nothing is redelivered.
    expect(room.outcomes(a)).toEqual(["processed"]);
    // B: its turn failed without ending durably — it runs again, posts nothing, and its
    // unknown publication is reported when the room's journal reopens; the re-run ends processed.
    await platform.rest.settled.next((settled) => settled.messageId === b && settled.outcome === "processed");

    expect(second.handled).toEqual([b]);
    expect(posts).toHaveLength(postedBeforeRestart);
    expect(reported(second.events)).toEqual([{ type: "delivery.unrecorded", roomId: ROOM, messageId: b }]);
    expect(await journalRecords(journalDir)).toEqual([
      "reply.intent", "reply.settled", "turn.done",
      // B's re-run ends on a poisoned journal: its end stands unrecorded, and the mark settles it.
      "reply.intent", "reply.unknown", "publication.reported",
    ]);
  });
});

describe("a reply whose delivery cannot stand", () => {
  it("records a settled-but-unrecordable reply as unknown, and the room stops admitting replies", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    // Band takes the post, but the disk will not take the settlement that records the yes.
    await failJournalAppends((line) => line.includes("reply.settled"));
    await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.sendMessage("answered", ["@owner"]).catch(() => undefined);
    });
    const inbound = await room.say(OWNER, `${MENTION} hello`);

    // The transport took the reply; the record that says so cannot stand. The reply stands
    // unknown — reported, not resent — and the writer that lost the write it owes stops
    // admitting: a second reply in the room is refused without a second post.
    expect(await room.outcome(inbound)).toBe("failed");
    expect(room.messages).toHaveLength(1);
    expect(room.failureLabels(inbound)).toEqual([expect.stringContaining("delivery is unknown")]);
    expect(await journalRecords(journalDir)).toEqual(["reply.intent", "reply.unknown"]);

    const again = await room.say(OWNER, `${MENTION} again`);
    expect(await room.outcome(again)).toBe("failed");
    expect(room.messages).toHaveLength(1);
  });

  it("keeps the delivery-unknown classification across a registered MCP call, sanitized", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    // The platform answers the post with 503: it may hold the reply, and cannot say.
    const posts: string[] = [];
    const original = platform.rest.createChatMessage.bind(platform.rest);
    const spy = vi.spyOn(platform.rest, "createChatMessage").mockImplementation(async (roomId, message, options) => {
      posts.push(message.content);
      if (message.content === "may be held") {
        throw new BandError({ statusCode: 503, body: { error: { code: "server_error", message: "Service unavailable", request_id: "req-1" } } });
      }
      return original(roomId, message, options);
    });
    onTestFinished(() => spy.mockRestore());

    const seen: string[] = [];
    await startProcess(platform, journalDir, async ({ tools }) => {
      // As the Claude SDK and ACP adapters reply: a registered client on the in-process Band MCP server.
      const bridge = createBandSdkMcpServer({ enableMemoryTools: false, getToolsForRoom: () => tools });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await bridge.serverConfig.instance.connect(serverTransport);
      const client = new Client({ name: "unknown-delivery-test", version: "1.0.0" });
      await client.connect(clientTransport);
      try {
        const result = await client.callTool({ name: "band_send_message", arguments: { room_id: ROOM, content: "may be held", mentions: ["@owner"] } });
        // A registered call keeps the classification: the result says the delivery is
        // unknown, sanitized — no adapter text, no status, no recovery advice.
        expect(result.isError).toBe(true);
        const block = (result.content as Array<{ type: string; text: string }>)[0];
        const text = block.text;
        seen.push(text);
        expect(JSON.parse(text)).toEqual({ delivery: "unknown" });
      } finally {
        await client.close();
      }
    });
    const inbound = await room.say(OWNER, `${MENTION} hello`);
    await platform.rest.settled.next((settled) => settled.messageId === inbound);

    expect(posts).toEqual(["may be held"]);
    expect(seen).toEqual([JSON.stringify({ delivery: "unknown" })]);
    expect(room.failureLabels(inbound)).toEqual([expect.stringContaining("delivery is unknown")]);
    expect(await journalRecords(journalDir)).toEqual(["reply.intent", "reply.unknown"]);
  });
});

describe("an unresolved publication with no inbound to ride on", () => {
  it("reports a room's unresolved publications when the room is admitted, without any inbound", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    await platform.room(ROOM);
    const journalDir = tmpRoot();
    // An earlier process posted a reply and died mid-settlement: the reply stands unknown on disk.
    await seedRoomRecords(journalDir, ROOM, async (room) => {
      const publicationId = await room.beginReply("m-old");
      await room.markUnknown("m-old", publicationId);
    });

    const { events } = await startProcess(platform, journalDir, async () => undefined);
    // No message is ever served to the room: the report rides on the room's admission.
    await events.next((event) => event.type === "delivery.unrecorded");
    expect(reported(events)).toEqual([{ type: "delivery.unrecorded", roomId: ROOM, messageId: "m-old" }]);
    expect(await journalRecords(journalDir)).toEqual(["reply.intent", "reply.unknown", "publication.reported"]);
  });
});

describe("the turn journal when Band serves a message again", () => {
  it("settles a failed turn's message from its settled reply after a restart, without running its adapter again", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} hello`);
    const first = await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.sendMessage("partial", ["@owner"]);
      throw new Error("the model call failed");
    });
    expect(await room.outcome(inbound)).toBe("failed");
    await first.runtime.stop(KILL);
    // The turn failed, but its reply stands settled — that settles the message on a restart.
    expect(await journalRecords(journalDir)).toEqual(["reply.intent", "reply.settled"]);

    const second = await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.sendMessage("answered", ["@owner"]);
    });
    // The re-serve settles from the settled reply: claimed and marked processed without a turn.
    await platform.rest.settled.next((settled) => settled.messageId === inbound && settled.outcome === "processed");

    expect(room.outcomes(inbound)).toEqual(["failed", "processed"]);
    expect(second.handled).toEqual([]);
    expect(room.messages.map((posted) => posted.content)).toEqual(["partial"]);
    expect(reported(second.events)).toEqual([]);
    expect(await journalRecords(journalDir)).toEqual(["reply.intent", "reply.settled"]);
  });

  it("settles a stopped turn's message on play from its settled reply, and posts the stopped room's late reply nowhere", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const released = createDeferred();
    onTestFinished(() => released.resolve());
    const journalDir = tmpRoot();
    const refused = createDeferred<unknown>();
    const { events } = await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.sendMessage("partial", ["@owner"]);
      await released.promise;
      // Cut short: the room is stopped when the post goes out, so the platform refuses it.
      await tools.sendMessage("late", ["@owner"]).then(refused.resolve, refused.resolve);
    });
    const inbound = await room.say(OWNER, `${MENTION} hello`);
    await room.until(() => room.messages.length === 1);

    platform.control("stop", ROOM);
    await events.next((event) => event.type === "turn.stopped");
    released.resolve();
    const error = await refused.promise;
    expect(error).toBeInstanceOf(Error);
    platform.control("play", ROOM);

    // The stopped turn's reply stands settled: on play the message is settled from it —
    // the adapter is not run again. The stop mode forgets the message without recording
    // its end, and the late reply was posted to a stopped room with no journal to record
    // it: the platform refused it, so it stands nowhere.
    expect(await room.outcome(inbound)).toBe("processed");
    expect(room.messages.map((posted) => posted.content)).toEqual(["partial"]);
    expect(reported(events)).toEqual([]);
    expect(await journalRecords(journalDir)).toEqual([
      "reply.intent", "reply.settled",
    ]);
  });
});

describe("the turn journal while a room's handling stops and starts", () => {
  it("records a reset turn's late reply when its journal reopens for it, leaving the message unmarked", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const keepWorking = createDeferred();
    onTestFinished(() => keepWorking.resolve());
    const lateSent = createDeferred<unknown>();
    const reached = createDeferred();
    let turns = 0;
    room.postBeforeConnect(OWNER, `${MENTION} hello`);
    const { runtime, events } = await startProcess(platform, journalDir, async ({ tools }) => {
      turns += 1;
      if (turns === 1) {
        reached.resolve();
        // An adapter that cannot be cancelled keeps working past the reset's budget; its turn detaches.
        await keepWorking.promise;
        await tools.sendMessage("late", ["@owner"]).then(lateSent.resolve, lateSent.resolve);
        return;
      }
      await tools.sendMessage("answered", ["@owner"]);
    });
    await reached.promise;

    // The turn cannot be cancelled within the budget: the reset fails and detaches the turn.
    // The room's execution stops with the reset, so the turn's settlement is dropped when
    // it ends: its message stands unmarked on the platform.
    expect(await runtime.resetRoomSession(ROOM, KILL)).toBe(false);
    await events.next((event) => event.type === "room.stopped");

    keepWorking.resolve();
    // The room's journal closed with the reset: the late reply posts unrecorded, and is delivered.
    await lateSent.promise;
// The process dies before the detached turn can settle its message: it is left unmarked.
    await runtime.stop(KILL);

    // The reset closed the room's journal, but the still-running detached turn reopens it on
    // demand when its late reply posts: the reply stands recorded, while the message itself is
    // left unmarked and the turn writes no end — a later process answers the message again.
    expect(room.messages.map((posted) => posted.content)).toEqual(["late"]);
    expect(reported(events)).toEqual([]);
    expect(await journalRecords(journalDir)).toEqual(["reply.intent", "reply.settled"]);
  });

  it("settles a finished message Band serves again after its room was left and rejoined, without running it", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const opened = vi.spyOn(RoomJournal, "open");
    onTestFinished(() => opened.mockRestore());
    const { handled, events } = await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.sendMessage("answered", ["@owner"]);
    });
    // The turn finishes but Band never hears it was processed.
    const mark = room.holdNextProcessed({ error: new Error("503 from Band") });
    const inbound = await room.say(OWNER, `${MENTION} hello`);
    await mark.sending;
    mark.release();
    await room.remove();
    await events.next((event) => event.type === "room.stopped");

    const rejoined = await platform.room(ROOM);
    await platform.rest.settled.next((settled) => settled.messageId === inbound && settled.outcome === "processed");

    expect(handled).toEqual([inbound]);
    expect(opened).toHaveBeenCalledTimes(2);
    expect(rejoined.messages.map((posted) => posted.content)).toEqual(["answered"]);
    expect(await journalRecords(journalDir)).toEqual(["reply.intent", "reply.settled", "turn.done"]);
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

  it("binds its journal to the attested identity and opens nothing for a synthetic contact-hub turn", async () => {
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
    expect((await readdir(agentJournalDir(journalDir, AGENT_ID))).sort()).toEqual([
      ".ownership.sqlite",
      // The lock connection holds its write transaction open for the run's lifetime.
      ".ownership.sqlite-journal",
      identityDirectoryComponent(IDENTITY),
    ]);
  });
});

describe("a start that cannot or will not journal", () => {
  it("fails start when journalDir is not a usable directory, and a successor start runs without a manual stop", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const file = path.join(tmpRoot(), "journal");
    await writeFile(file, "not a directory");

    await expect(startProcess(platform, file, async () => undefined)).rejects.toBeInstanceOf(ValidationError);

    // The failed start released nothing it did not take: a new start on a usable directory runs.
    const journalDir = tmpRoot();
    const { handled } = await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.sendMessage("answered", ["@owner"]);
    });

    expect(await room.outcome(await room.say(OWNER, `${MENTION} hello`))).toBe("processed");
    expect(handled).toHaveLength(1);
    expect(await journalRecords(journalDir)).toEqual(["reply.intent", "reply.settled", "turn.done"]);
  });

  it("refuses a custom adapter's journal without its attested platform identity, naming the setting", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    await platform.room(ROOM);
    await expect(startProcess(platform, tmpRoot(), async () => undefined, { withIdentity: false })).rejects.toThrow(
      expect.objectContaining({ message: expect.stringContaining("sessionConfig.journalPlatformIdentity") }),
    );
  });

  it("refuses an identity that cannot stand as a platform's canonical one", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    await platform.room(ROOM);
    await expect(
      startProcess(platform, tmpRoot(), async () => undefined, { sessionConfig: { journalPlatformIdentity: "https://user:pass@example.com" } }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("stops cleanly when a room's journal fails to close", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const { runtime } = await startProcess(platform, tmpRoot(), async ({ tools }) => {
      await tools.sendMessage("answered", ["@owner"]);
    });
    expect(await room.outcome(await room.say(OWNER, `${MENTION} hello`))).toBe("processed");
    // Really closes, then reports a failure, so no handle outlives the test.
    const realClose = RoomJournal.prototype.close;
    const close = vi.spyOn(RoomJournal.prototype, "close").mockImplementationOnce(async function (this: RoomJournal) {
      await realClose.call(this);
      throw new Error("EIO: i/o error, close");
    });
    onTestFinished(() => close.mockRestore());

    expect(await runtime.stop()).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(runtime.state.status).toBe("stopped");
  });
});

describe("the turn journal against a failed start and a stale generation", () => {
  it("lets a start fail over ownership a stale generation took, without closing the successor's journal", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const answers: Handler = async ({ tools }) => {
      await tools.sendMessage("answered", ["@owner"]);
    };
    const { runtime } = await startProcess(platform, journalDir, answers);
    expect(await room.outcome(await room.say(OWNER, `${MENTION} one`))).toBe("processed");
    expect(await runtime.stop()).toBe(true);

    // A new start activates the journal, held here until the stop below superseded it.
    const originalActivate = TurnJournal.prototype.activate;
    const activateHeld = createDeferred();
    const activateStarted = createDeferred();
    const held = vi.spyOn(TurnJournal.prototype, "activate").mockImplementationOnce(function (this: TurnJournal, ...args: [identity: string]) {
      activateStarted.resolve();
      return (async () => {
        await activateHeld.promise;
        return originalActivate.apply(this, args);
      })();
    });
    onTestFinished(() => held.mockRestore());

    const superseded = runtime.start(new GenericAdapter(answers));
    await activateStarted.promise;
    // The stop takes over while the start holds its activation.
    expect(await runtime.stop()).toBe(true);
    // The start activates its generation, finds itself superseded, and gives its ownership back.
    activateHeld.resolve();
    await expect(superseded).rejects.toThrow("superseded");

    // The successor start takes the same journal root and agent without contending for it.
    await runtime.start(new GenericAdapter(answers));
    expect(await room.outcome(await room.say(OWNER, `${MENTION} two`))).toBe("processed");
    expect(await journalRecords(journalDir)).toEqual([
      "reply.intent", "reply.settled", "turn.done",
      "reply.intent", "reply.settled", "turn.done",
    ]);
  });

  it("keeps ownership held through a stop that timed out on the rooms, until the last publication stands on disk", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const { runtime } = await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.sendMessage("late", ["@owner"]);
    });
    // The reply's post stands in flight; its acknowledgement and record are the drain's.
    const hold = platform.rest.messageHolds.hold((roomId, content) => content === "late");
    const inbound = await room.say(OWNER, `${MENTION} hello`);
    await hold.sending;

    const stopping = runtime.stop(50);
    // Past the stop's budget: the rooms are torn down, the state is stopping, and the
    // start's start is refused while the last publication drains.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(runtime.state.status).toBe("stopping");
    await expect(runtime.start(new GenericAdapter(async () => undefined))).rejects.toBeInstanceOf(Error);
    await expect(new TurnJournal(journalDir, AGENT_ID).activate(IDENTITY)).rejects.toBeInstanceOf(JournalOwnershipError);

    hold.release();
    expect(await stopping).toBe(false);
    expect(runtime.state.status).toBe("stopped");
    // The settlement stands on disk before the ownership released, and the ownership is free now.
    expect(await journalRecords(journalDir)).toEqual(["reply.intent", "reply.settled"]);
    // Its message's mark was cut short with the rooms: it stays left on the platform, and its reply's outcome stands on disk.
    expect(platform.rest.settled.entries.filter((settled) => settled.messageId === inbound)).toEqual([]);
    const after = await new TurnJournal(journalDir, AGENT_ID).activate(IDENTITY);
    await after.close();
  });
});

describe("a turn journal that fails", () => {
  it("refuses a reply whose room's journal will not open, and serves it once the journal opens", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const other = await platform.room(OTHER_ROOM);
    const journalDir = tmpRoot();
    // The room's journal path is taken by a directory: its authority cannot be opened,
    // and the room serves no reply it cannot record.
    await mkdir(journalFile(journalDir), { recursive: true });
    const { runtime, handled } = await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.sendMessage("answered", ["@owner"]);
    });

    const blocked = await room.say(OWNER, `${MENTION} one`);
    // The room's authority stands it cannot open: the reply is refused, nothing posts, and the turn fails.
    expect(await room.outcome(blocked)).toBe("failed");
    expect(room.messages).toEqual([]);
    // The runtime keeps serving: another room whose journal opens runs as usual.
    const fine = await other.say(OWNER, `${MENTION} hello`);
    expect(await other.outcome(fine)).toBe("processed");
    await rm(journalFile(journalDir), { recursive: true });
    const journaled = await room.say(OWNER, `${MENTION} two`);
    expect(await room.outcome(journaled)).toBe("processed");

    expect(handled).toEqual([blocked, fine, journaled]);
    expect(runtime.state.status).toBe("running");
    expect(await journalRecords(journalDir)).toEqual(["reply.intent", "reply.settled", "turn.done"]);
  });

  it("fails the turn and posts nothing when the disk will not take the reply's intent", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    await failJournalAppends((line) => line.includes('"t":"reply.intent"'));
    const { runtime } = await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.sendMessage("answered", ["@owner"]);
    });

    const inbound = await room.say(OWNER, `${MENTION} hello`);
    expect(await room.outcome(inbound)).toBe("failed");
    expect(room.messages).toEqual([]);
    expect(await journalRecords(journalDir)).toEqual([]);
    expect(runtime.state.status).toBe("running");
  });

  it("still answers a message again when its repeat report cannot be recorded", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} hello`);
    await seedRoomRecords(journalDir, ROOM, (room) => room.beginReply(inbound));
    await failJournalAppends((line) => line.includes('"publication.reported"'));

    const { handled, events } = await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.sendMessage("answered", ["@owner"]);
    });

    expect(await room.outcome(inbound)).toBe("processed");
    expect(handled).toEqual([inbound]);
    expect(reported(events)).toEqual([{ type: "delivery.unrecorded", roomId: ROOM, messageId: inbound }]);
    // The report's record could not be written; the uncertainty stands on its intent, and is announced again on the next open.
    expect(await journalRecords(journalDir)).toEqual(["reply.intent", "reply.intent", "reply.settled", "turn.done"]);
  });
});

const answers: Handler = async ({ tools }) => {
  await tools.sendMessage("answered", ["@owner"]);
};

describe("what the turn journal records and reports", () => {
  it("records no end for a turn that hands its reply to later work, so a restart answers its message again", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} hello`);
    const mark = platform.rest.processedHolds.hold((messageId) => messageId === inbound);
    const first = await startProcess(platform, journalDir, async ({ tools }) => {
      // A decision wait: the reply would follow its answer, which never comes here.
      const decided = new Promise<never>(() => undefined);
      await runUntilReleased(tools, () => decided, Promise.resolve(), new NoopLogger(), {}, () => undefined);
    });
    await mark.sending;
    await first.runtime.stop(KILL);
    expect(await journalRecords(journalDir)).toEqual([]);

    const second = await startProcess(platform, journalDir, answers);

    await platform.rest.settled.next((settled) => settled.messageId === inbound && settled.outcome === "processed");
    expect(second.handled).toEqual([inbound]);
    expect(room.messages.map((posted) => posted.content)).toEqual(["answered"]);
    expect(await journalRecords(journalDir)).toEqual(["reply.intent", "reply.settled", "turn.done"]);
  });

  it("does not count a notice as a reply, even one sent while a reply is posting", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.sendNotice("working on it", ["@owner"]);
      await tools.sendMessage("answered", ["@owner"]);
    });

    expect(await room.outcome(await room.say(OWNER, `${MENTION} hello`))).toBe("processed");

    expect(room.messages.map((posted) => posted.content)).toEqual(["working on it", "answered"]);
    expect(await journalRecords(journalDir)).toEqual(["reply.intent", "reply.settled", "turn.done"]);
  });

  it("records each room's replies under its own message while turns in two rooms overlap", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const other = await platform.room(OTHER_ROOM);
    const journalDir = tmpRoot();
    await startProcess(platform, journalDir, answers);
    const append = await holdJournalAppend((line) => line.includes('"t":"reply.intent"'));
    const first = await room.say(OWNER, `${MENTION} hello`);
    await append.entered;

    const second = await other.say(OWNER, `${MENTION} hello`);
    expect(await other.outcome(second)).toBe("processed");
    append.release();
    expect(await room.outcome(first)).toBe("processed");

    const roomLines = await journalLines(journalFile(journalDir, ROOM));
    expect(roomLines.map((line) => String(line.t))).toEqual(["reply.intent", "reply.settled", "turn.done"]);
    expect(String((roomLines[0] as { messageId: string }).messageId)).toBe(first);
    expect(String((roomLines[2] as { messageId: string }).messageId)).toBe(first);
    const otherLines = await journalLines(journalFile(journalDir, OTHER_ROOM));
    expect(otherLines.map((line) => String(line.t))).toEqual(["reply.intent", "reply.settled", "turn.done"]);
    expect(String((otherLines[0] as { messageId: string }).messageId)).toBe(second);
    expect(String((otherLines[2] as { messageId: string }).messageId)).toBe(second);
  });

  it("reports each unresolved publication once, however many the earlier turn began", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} hello`);
    await seedRoomRecords(journalDir, ROOM, async (room) => {
      await room.beginReply(inbound);
      await room.beginReply(inbound);
    });

    const { events } = await startProcess(platform, journalDir, answers);

    expect(await room.outcome(inbound)).toBe("processed");
    // Each publication the journal still cannot confirm is reported, none hidden under an older marker.
    expect(reported(events)).toEqual([
      { type: "delivery.unrecorded", roomId: ROOM, messageId: inbound },
      { type: "delivery.unrecorded", roomId: ROOM, messageId: inbound },
    ]);
    expect(await journalRecords(journalDir)).toEqual([
      "reply.intent", "reply.intent", "publication.reported", "publication.reported",
      "reply.intent", "reply.settled", "turn.done",
    ]);
  });

  it("reports an unrecorded reply when the journal reopens for its message, though the turn was stopped before it started", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} hello`);
    await seedRoomRecords(journalDir, ROOM, (room) => room.beginReply(inbound));
    const claim = room.holdProcessing(inbound);
    const { events, handled } = await startProcess(platform, journalDir, answers);
    await claim.sending;

    platform.control("stop", ROOM);
    await events.next((event) => event.type === "room.paused");
    claim.release();
    platform.control("play", ROOM);

    await platform.rest.settled.next((settled) => settled.messageId === inbound && settled.outcome === "processed");
    expect(handled).toEqual([inbound]);
    expect(reported(events)).toHaveLength(1);
    // The report stands on the journal's reopen for the message, ahead of the attempt that answers it.
    const report = events.entries.findIndex((event) => event.type === "delivery.unrecorded");
    const started = events.entries.findIndex((event) => event.type === "turn.started");
    expect(report).toBeLessThan(started);
  });

  it("reports an unrecorded reply even when an interrupt consumes its message", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} hello`);
    await seedRoomRecords(journalDir, ROOM, (room) => room.beginReply(inbound));
    const claim = room.holdProcessing(inbound);
    const { events, handled } = await startProcess(platform, journalDir, answers);
    await claim.sending;

    platform.control("interrupt", ROOM);
    const mark = room.holdNextProcessed();
    claim.release();
    await mark.sending;
    mark.release();

    expect(await room.outcome(inbound)).toBe("processed");
    expect(handled).toEqual([]);
    // The journal was reopened for the message its turn consumed; its uncertainty is exposed, independent of the settlement.
    expect(reported(events)).toEqual([{ type: "delivery.unrecorded", roomId: ROOM, messageId: inbound }]);
    expect(await journalRecords(journalDir)).toEqual(["reply.intent", "publication.reported", "turn.done"]);
  });

  it("records a cut-short reply's intent, refused by the stopped room, and reports it when the room reopens", async () => {
    const platform = BandPlatform.host([person(OWNER), person("bob")]);
    const room = await platform.room(ROOM, [person(OWNER)]);
    const journalDir = tmpRoot();
    const lookup = createDeferred<HeldCall<[roomId: string]>>();
    const refused = createDeferred<unknown>();
    let turns = 0;
    const { events, handled } = await startProcess(platform, journalDir, async ({ tools }) => {
      turns += 1;
      if (turns > 1) {
        await tools.sendMessage("answered", ["@owner"]);
        return;
      }
      // Bob joined without the agent hearing of it, so mentioning him fetches the room's participants.
      await platform.rest.addChatParticipant(ROOM, { participantId: "bob" });
      lookup.resolve(platform.rest.participantHolds.hold(() => true));
      await tools.sendMessage("late", ["@bob"]).then(refused.resolve, refused.resolve);
    });
    const inbound = await room.say(OWNER, `${MENTION} hello`);
    const fetch = await lookup.promise;
    await fetch.sending;

    platform.control("stop", ROOM);
    await events.next((event) => event.type === "turn.stopped");
    fetch.release();

    // The post goes out to the stopped room: the platform refuses it, and the stop closed
    // the room's journal, so its refusal stands unrecorded. Its intent did stand, though.
    const error = await refused.promise;
    expect(error).toBeInstanceOf(Error);
    // The intent stood before the roster lookup. The stop holds the room's journal open until
    // this in-flight post stands, and the stopped room refuses it: the refusal is recorded, so
    // the reply stands known-refused, not unknown.
    expect(await journalRecords(journalDir)).toEqual(["reply.intent", "reply.refused"]);
    platform.control("play", ROOM);
    expect(await room.outcome(inbound)).toBe("processed");
    expect(handled).toEqual([inbound, inbound]);
    expect(room.messages.map((posted) => posted.content)).toEqual(["answered"]);
    expect(reported(events)).toEqual([]);
    expect(await journalRecords(journalDir)).toEqual([
      "reply.intent", "reply.refused",
      "reply.intent", "reply.settled", "turn.done",
    ]);
  });

  it("opens nothing for an earlier run's late reply once a stop superseded the next start", async () => {
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

    const starting = runtime.start(new GenericAdapter(async () => undefined));
    expect(await runtime.stop()).toBe(true);
    await expect(starting).rejects.toThrow("superseded");
    const opened = vi.spyOn(RoomJournal, "open");
    onTestFinished(() => opened.mockRestore());
    keepWorking.resolve();
    await sent.promise;

    expect(opened).not.toHaveBeenCalled();
    expect(runtime.state.status).toBe("stopped");
  });
});