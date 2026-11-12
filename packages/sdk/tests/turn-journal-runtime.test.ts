import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { DEFAULT_JOURNAL_RETENTION_SECONDS, type SessionConfig } from "../src/runtime/types";
import { AGENT_API_KEY, AGENT_ID, BandPlatform, person } from "./flows/support/bandPlatform";
import { RecordLog, tmpRoot } from "./testUtils";

const OWNER = "owner";
const ROOM = "room-1";
const OTHER_ROOM = "room-2";
const MENTION = `@[[${AGENT_ID}]]`;
/** A stop that waits for nothing: the process is killed with its turn and marks in flight. */
const KILL = 0;
const RETENTION_MS = DEFAULT_JOURNAL_RETENTION_SECONDS * MS_PER_SECOND;

type Handler = GenericAdapterHandler;

/**
 * One process of the agent: a runtime on `platform` journaling to `journalDir`,
 * or not journaling without one. Stopped when the test ends, if it still runs.
 */
async function startProcess(
  platform: BandPlatform,
  journalDir: string | undefined,
  handler: Handler,
  sessionConfig: Omit<SessionConfig, "journalDir"> = {},
) {
  const handled: string[] = [];
  const events = new RecordLog<AgentEvent>();
  const runtime = new PlatformRuntime({
    agentId: AGENT_ID,
    apiKey: AGENT_API_KEY,
    linkOptions: platform.link,
    agentConfig: { autoSubscribeExistingRooms: true },
    sessionConfig: journalDir === undefined ? sessionConfig : { ...sessionConfig, journalDir },
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

async function journalRecords(journalDir: string): Promise<string[]> {
  const text = await readFile(journalFile(journalDir), "utf8");
  return text.split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { t: string }).t);
}

const reported = (events: RecordLog<AgentEvent>) => events.entries.filter((event) => event.type === "delivery.unrecorded");

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
    expect(await journalRecords(journalDir)).toEqual(["reply.intent", "delivery.unrecorded", "reply.intent", "reply.intent", "turn.done"]);
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
  });

  it("runs a stopped turn's message again on play, though the stopped turn had replied", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const released = createDeferred();
    onTestFinished(() => released.resolve());
    let turns = 0;
    const { handled, events } = await startProcess(platform, tmpRoot(), async ({ tools }) => {
      turns += 1;
      if (turns === 1) {
        await tools.sendMessage("partial", ["@owner"]);
        await released.promise;
        return;
      }
      await tools.sendMessage("answered", ["@owner"]);
    });
    const inbound = await room.say(OWNER, `${MENTION} hello`);
    await room.until(() => room.messages.length === 1);

    platform.control("stop", ROOM);
    await events.next((event) => event.type === "turn.stopped");
    released.resolve();
    platform.control("play", ROOM);

    expect(await room.outcome(inbound)).toBe("processed");
    expect(handled).toEqual([inbound, inbound]);
    expect(room.messages.map((posted) => posted.content)).toEqual(["partial", "answered"]);
    expect(reported(events)).toEqual([{ type: "delivery.unrecorded", roomId: ROOM, messageId: inbound }]);
  });

  it("records an interrupted turn's end before its message is consumed, so a restart does not run it", async () => {
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
});

describe("a turn journal that fails", () => {
  it("fails start when journalDir is not a usable directory", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    await platform.room(ROOM);
    const file = path.join(tmpRoot(), "journal");
    await writeFile(file, "not a directory");

    await expect(startProcess(platform, file, async () => undefined)).rejects.toBeInstanceOf(ValidationError);
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
    const full = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    const replyBegun = vi.spyOn(RoomJournal.prototype, "replyBegun").mockRejectedValue(full);
    const turnDone = vi.spyOn(RoomJournal.prototype, "turnDone").mockRejectedValue(full);
    onTestFinished(() => {
      replyBegun.mockRestore();
      turnDone.mockRestore();
    });
    const { runtime } = await startProcess(platform, tmpRoot(), async ({ tools }) => {
      await tools.sendMessage("answered", ["@owner"]);
    });

    expect(await room.outcome(await room.say(OWNER, `${MENTION} hello`))).toBe("processed");

    expect(room.messages.map((posted) => posted.content)).toEqual(["answered"]);
    expect(replyBegun).toHaveBeenCalledTimes(1);
    expect(turnDone).toHaveBeenCalledTimes(1);
    expect(runtime.state.status).toBe("running");
  });

  it("forgets a message one journalRetentionSeconds after its last record", async () => {
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
    vi.advanceTimersByTime(60 * MS_PER_SECOND + 1);

    const { handled } = await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.sendMessage("answered", ["@owner"]);
    }, { journalRetentionSeconds: 60 });

    expect(await room.outcome(inbound)).toBe("processed");
    expect(handled).toEqual([inbound]);
  });
});
