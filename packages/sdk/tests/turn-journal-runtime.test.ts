import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { GenericAdapter, type GenericAdapterHandler } from "../src/adapters/GenericAdapter";
import type { AgentEvent } from "../src/contracts/events";
import { isFailedToolOutput } from "../src/contracts/protocols";
import { createDeferred } from "../src/core/deferred";
import { ValidationError } from "../src/core/errors";
import { createBandSdkMcpServer } from "../src/mcp/sdk";
import { relayReply } from "../src/core/turn";
import { PlatformRuntime } from "../src/runtime";
import { agentJournalDir, roomJournalFile, TurnJournal } from "../src/runtime/journal/TurnJournal";
import { DEFAULT_JOURNAL_RETENTION_SECONDS, type SessionConfig } from "../src/runtime/types";
import { MS_PER_SECOND } from "../src/core/deadline";
import { AGENT_API_KEY, AGENT_ID, BandPlatform, person } from "./flows/support/bandPlatform";
import { RecordLog, tmpRoot } from "./testUtils";

const OWNER = "owner";
const ROOM = "room-1";
const OTHER_ROOM = "room-2";
/** A stop that waits for nothing: the process is killed with its turn and marks in flight. */
const KILL = 0;
const RETENTION_MS = DEFAULT_JOURNAL_RETENTION_SECONDS * MS_PER_SECOND;
const MENTION = `@[[${AGENT_ID}]]`;

type Handler = GenericAdapterHandler;

/** One process of the agent: a runtime on `platform` journaling to `journalDir`, or not journaling without one. */
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

/** The agent's journal under `journalDir`, as another process left it. */
function journalOf(journalDir: string): TurnJournal {
  return new TurnJournal(journalDir, AGENT_ID, { retentionMs: RETENTION_MS });
}

async function journalLines(journalDir: string): Promise<string[]> {
  const text = await readFile(journalFile(journalDir), "utf8");
  return text.split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { t: string }).t);
}

const POSTED = ["reply.intent", "reply.posted"];

/** Each reply path, and the records its reply leaves before the turn's end. */
const replyPaths: Array<[string, Handler, string[]]> = [
  ["band_send_message", async ({ tools }) => {
    await tools.executeToolCall("band_send_message", { content: "answered", mentions: ["@owner"] });
  }, POSTED],
  ["sendMessage", async ({ tools }) => {
    await tools.sendMessage("answered", ["@owner"]);
  }, POSTED],
  ["the relayed closing text", async ({ tools }) => {
    await relayReply(tools, "answered", ["@owner"]);
  }, POSTED],
  ["band_no_reply", async ({ tools }) => {
    await tools.executeToolCall("band_no_reply", { reason: "nothing to add" });
  }, ["reply.declined"]],
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
  }, POSTED],
];

describe("the turn journal across a restart", () => {
  it.each(replyPaths)("journals %s at the same point and does not answer the inbound again after a restart that beat the processed mark", async (_replyPath, answer, recorded) => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} hello`);
    // The process dies after its reply is posted and recorded, before Band hears it was processed:
    // its processed mark never completes, and it stops without waiting for it.
    const mark = platform.rest.processedHolds.hold((messageId) => messageId === inbound);
    const first = await startProcess(platform, journalDir, answer);
    await mark.sending;
    await first.runtime.stop(KILL);
    const postedBefore = room.posted.length;
    expect(await journalLines(journalDir)).toEqual([...recorded, "turn.done"]);

    const second = await startProcess(platform, journalDir, answer);

    expect(await room.outcome(inbound)).toBe("processed");
    expect(second.handled).toEqual([]);
    expect(room.posted).toHaveLength(postedBefore);
    await second.runtime.stop();
  });

  it("records each reply of a multi-message turn, and the turn's end before it is marked processed", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const { runtime } = await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.executeToolCall("band_send_message", { content: "first", mentions: ["@owner"] });
      await tools.sendMessage("second", ["@owner"]);
    });
    const mark = room.holdNextProcessed();

    const inbound = await room.say(OWNER, `${MENTION} two answers please`);
    await mark.sending;

    expect(await journalLines(journalDir)).toEqual(["reply.intent", "reply.posted", "reply.intent", "reply.posted", "turn.done"]);
    mark.release();
    expect(await room.outcome(inbound)).toBe("processed");
    expect(room.messages.map((posted) => posted.content)).toEqual(["first", "second"]);
    await runtime.stop();
  });

  it("does not repost the replies of a turn killed between its first and second reply", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} two answers please`);
    const sentFirst = createDeferred();
    const first = await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.executeToolCall("band_send_message", { content: "first", mentions: ["@owner"] });
      sentFirst.resolve();
      // Killed here: the second reply is never sent.
      await new Promise<never>(() => undefined);
    });
    await sentFirst.promise;
    await first.runtime.stop(KILL);
    expect(await journalLines(journalDir)).toEqual(["reply.intent", "reply.posted"]);

    const second = await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.executeToolCall("band_send_message", { content: "first", mentions: ["@owner"] });
      await tools.sendMessage("second", ["@owner"]);
    });

    expect(await room.outcome(inbound)).toBe("processed");
    expect(second.handled).toEqual([]);
    // The unsent tail is lost; the reply already posted is not posted again.
    expect(room.messages.map((posted) => posted.content)).toEqual(["first"]);
    expect(await journalLines(journalDir)).toEqual(["reply.intent", "reply.posted", "turn.done"]);
    await second.runtime.stop();
  });

  it("dispatches nothing for an inbound whose turn ended before a restart, and still bootstraps the next turn", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} hello`);
    // A turn that ended without a reply journaled: it settled, or reported its failure.
    const ended = journalOf(journalDir);
    await (await ended.room(ROOM)).turnDone(inbound);
    await ended.close();

    const bootstraps: boolean[] = [];
    const { runtime, handled } = await startProcess(platform, journalDir, async ({ tools, isSessionBootstrap }) => {
      bootstraps.push(isSessionBootstrap);
      await tools.sendMessage("answered", ["@owner"]);
    });

    expect(await room.outcome(inbound)).toBe("processed");
    expect(handled).toEqual([]);
    expect(room.posted).toEqual([]);
    // The skipped inbound did not use up the session's first turn: the next one still bootstraps it.
    const next = await room.say(OWNER, `${MENTION} again`);
    expect(await room.outcome(next)).toBe("processed");
    expect(bootstraps).toEqual([true]);
    await runtime.stop();
  });

  it("records the intent before posting, so a kill after Band accepts the post is reported, not silently reposted", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} hello`);
    // Band accepts the post, then the process dies before the response reaches it.
    const createChatMessage = platform.rest.createChatMessage.bind(platform.rest);
    const postAccepted = createDeferred();
    platform.rest.createChatMessage = async (...args) => {
      await createChatMessage(...args);
      postAccepted.resolve();
      return await new Promise<never>(() => undefined);
    };
    const answer: Handler = async ({ tools }) => {
      await tools.executeToolCall("band_send_message", { content: "answered", mentions: ["@owner"], operation_id: "op-1" });
    };
    const first = await startProcess(platform, journalDir, answer);
    await postAccepted.promise;
    await first.runtime.stop(KILL);

    expect(room.messages.map((posted) => posted.content)).toEqual(["answered"]);
    expect(await journalLines(journalDir)).toEqual(["reply.intent"]);

    platform.rest.createChatMessage = createChatMessage;
    // The re-run turn answers under a new id: the first one's delivery stays uncertain.
    const second = await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.executeToolCall("band_send_message", { content: "answered", mentions: ["@owner"], operation_id: "op-2" });
    });

    // The killed process may have marked it failed on its way out; Band serves it again either way.
    await platform.rest.settled.next((settled) => settled.messageId === inbound && settled.outcome === "processed");
    expect(second.events.entries.filter((event) => event.type === "delivery.unrecorded")).toEqual([
      { type: "delivery.unrecorded", roomId: ROOM, messageId: inbound, operationId: "op-1" },
    ]);
    // The documented bound: the inbound is answered again, and the possible duplicate is reported.
    expect(second.handled).toEqual([inbound]);
    expect(await journalLines(journalDir)).toEqual([
      "reply.intent",
      "delivery.unrecorded",
      "reply.intent",
      "reply.posted",
      "turn.done",
    ]);
    await second.runtime.stop();
  });

  it("reports a reply whose post began but was never recorded, and answers the inbound again", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} hello`);
    // What a process killed mid-post leaves: the reply's intent, and nothing after it.
    const crashed = journalOf(journalDir);
    await (await crashed.room(ROOM)).beginReply(inbound, { tool: "band_send_message", digest: "d", operationId: "op-1" });
    await crashed.close();

    const { runtime, handled, events } = await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.sendMessage("answered", ["@owner"]);
    });

    expect(await room.outcome(inbound)).toBe("processed");
    expect(handled).toEqual([inbound]);
    expect(events.entries.filter((event) => event.type === "delivery.unrecorded")).toEqual([
      { type: "delivery.unrecorded", roomId: ROOM, messageId: inbound, operationId: "op-1" },
    ]);
    expect(await journalLines(journalDir)).toEqual(["reply.intent", "delivery.unrecorded", "reply.intent", "reply.posted", "turn.done"]);
    await runtime.stop();
  });

  it.each([
    ["band_send_message", async ({ tools }: Parameters<Handler>[0]) => {
      await tools.executeToolCall("band_send_message", { content: "answered", mentions: ["@owner"] });
    }],
    ["sendMessage", async ({ tools }: Parameters<Handler>[0]) => {
      await tools.sendMessage("answered", ["@owner"]);
    }],
  ] as const)("records a post Band refused through %s as failed, so a restart answers it again without reporting it", async (_path, answer) => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} hello`);
    const refused = room.holdMessage((content) => content === "answered", { error: Object.assign(new Error("unprocessable"), { statusCode: 422 }) });
    const mark = platform.rest.settled;
    const first = await startProcess(platform, journalDir, answer);
    await refused.sending;
    refused.release();
    await mark.next((settled) => settled.messageId === inbound);
    await first.runtime.stop(KILL);
    expect((await journalLines(journalDir)).slice(0, 2)).toEqual(["reply.intent", "reply.failed"]);

    // Band still serves it: the turn failed, or it settled with nothing posted.
    const second = await startProcess(platform, journalDir, answer);
    await room.until(() => room.messages.length === 1);

    expect(second.handled).toEqual([inbound]);
    expect(second.events.entries.filter((event) => event.type === "delivery.unrecorded")).toEqual([]);
    await second.runtime.stop();
  });
});

describe("operation_id", () => {
  async function agentReplying(handler: Handler) {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const process = await startProcess(platform, tmpRoot(), handler);
    return { platform, room, ...process };
  }

  it("posts a send retried with the same id and arguments once, and hands the retry the first result", async () => {
    const results: unknown[] = [];
    const { room, runtime } = await agentReplying(async ({ tools }) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        results.push(await tools.executeToolCall("band_send_message", { content: "once", mentions: ["@owner"], operation_id: "op-1" }));
      }
    });

    expect(await room.outcome(await room.say(OWNER, `${MENTION} hi`))).toBe("processed");

    expect(room.messages.map((posted) => posted.content)).toEqual(["once"]);
    expect(results[1]).toEqual(results[0]);
    expect(isFailedToolOutput(results[0])).toBe(false);
    await runtime.stop();
  });

  it("keeps an id across turns: a later turn's retry does not post again", async () => {
    const { room, runtime } = await agentReplying(async ({ tools }) => {
      await tools.executeToolCall("band_send_message", { content: "once", mentions: ["@owner"], operation_id: "op-1" });
    });

    expect(await room.outcome(await room.say(OWNER, `${MENTION} one`))).toBe("processed");
    expect(await room.outcome(await room.say(OWNER, `${MENTION} two`))).toBe("processed");

    expect(room.messages.map((posted) => posted.content)).toEqual(["once"]);
    await runtime.stop();
  });

  it("posts a retry again once its id is older than journalRetentionSeconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const { runtime } = await startProcess(platform, tmpRoot(), async ({ tools }) => {
      await tools.executeToolCall("band_send_message", { content: "once", mentions: ["@owner"], operation_id: "op-1" });
    }, { journalRetentionSeconds: 60 });

    expect(await room.outcome(await room.say(OWNER, `${MENTION} one`))).toBe("processed");
    vi.advanceTimersByTime(60 * MS_PER_SECOND);
    expect(await room.outcome(await room.say(OWNER, `${MENTION} two`))).toBe("processed");
    expect(room.messages.map((posted) => posted.content)).toEqual(["once"]);

    vi.advanceTimersByTime(1);
    expect(await room.outcome(await room.say(OWNER, `${MENTION} three`))).toBe("processed");
    expect(room.messages.map((posted) => posted.content)).toEqual(["once", "once"]);
    await runtime.stop();
  });

  it.each([
    ["band_send_message", { content: "original", mentions: ["@owner"] }, { content: "changed", mentions: ["@owner"] }, ["original"]],
    ["band_no_reply", { reason: "original" }, { reason: "changed" }, []],
  ] as const)("refuses %s under an id already used for different arguments, posting nothing", async (tool, first, changed, posted) => {
    const results: unknown[] = [];
    const { room, runtime } = await agentReplying(async ({ tools }) => {
      results.push(await tools.executeToolCall(tool, { ...first, operation_id: "op-1" }));
      results.push(await tools.executeToolCall(tool, { ...changed, operation_id: "op-1" }));
    });

    expect(await room.outcome(await room.say(OWNER, `${MENTION} hi`))).toBe("processed");

    expect(isFailedToolOutput(results[0])).toBe(false);
    expect(results[1]).toMatchObject({ ok: false, message: expect.stringContaining("op-1") });
    expect(room.messages.map((message) => message.content)).toEqual(posted);
    await runtime.stop();
  });

  it("lands concurrent calls under one id one at a time: one post, and the same result for both", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const post = room.holdMessage((content) => content === "once");
    const results: unknown[] = [];
    const { runtime } = await startProcess(platform, tmpRoot(), async ({ tools }) => {
      const send = { content: "once", mentions: ["@owner"], operation_id: "op-1" };
      const first = tools.executeToolCall("band_send_message", send);
      const second = tools.executeToolCall("band_send_message", send);
      results.push(...(await Promise.all([first, second])));
    });

    const inbound = await room.say(OWNER, `${MENTION} hi`);
    await post.sending;
    post.release();

    expect(await room.outcome(inbound)).toBe("processed");
    expect(room.messages.map((message) => message.content)).toEqual(["once"]);
    expect(isFailedToolOutput(results[0])).toBe(false);
    expect(results[1]).toEqual(results[0]);
    await runtime.stop();
  });

  it("keeps an id across a restart: the next process's retry returns the first result without posting", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const results: unknown[] = [];
    const answer: Handler = async ({ tools }) => {
      results.push(await tools.executeToolCall("band_send_message", { content: "once", mentions: ["@owner"], operation_id: "op-1" }));
    };
    const first = await startProcess(platform, journalDir, answer);
    expect(await room.outcome(await room.say(OWNER, `${MENTION} one`))).toBe("processed");
    await first.runtime.stop();

    const second = await startProcess(platform, journalDir, answer);
    expect(await room.outcome(await room.say(OWNER, `${MENTION} two`))).toBe("processed");

    expect(room.messages.map((message) => message.content)).toEqual(["once"]);
    expect(results[1]).toEqual(results[0]);
    await second.runtime.stop();
  });

  it("refuses a retry under an id whose first post failed without Band refusing it, since it may have posted", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    // Band takes the post, then the response is lost.
    const createChatMessage = platform.rest.createChatMessage.bind(platform.rest);
    let posts = 0;
    platform.rest.createChatMessage = async (...args) => {
      const result = await createChatMessage(...args);
      posts += 1;
      if (posts === 1) throw new Error("socket hang up");
      return result;
    };
    const results: unknown[] = [];
    const { runtime } = await startProcess(platform, tmpRoot(), async ({ tools }) => {
      const send = { content: "once", mentions: ["@owner"], operation_id: "op-1" };
      results.push(await tools.executeToolCall("band_send_message", send));
      results.push(await tools.executeToolCall("band_send_message", send));
      tools.turn.settle();
    });

    expect(await room.outcome(await room.say(OWNER, `${MENTION} hi`))).toBe("processed");

    expect(isFailedToolOutput(results[0])).toBe(true);
    expect(results[1]).toMatchObject({ ok: false, message: expect.stringContaining("may or may not have posted") });
    expect(room.messages.map((message) => message.content)).toEqual(["once"]);
    await runtime.stop();
  });

  it("dedupes a retry of a reply that landed after its turn was interrupted", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const firstTurnEnded = createDeferred();
    let turns = 0;
    const { runtime, events } = await startProcess(platform, tmpRoot(), async ({ tools }) => {
      turns += 1;
      try {
        await tools.executeToolCall("band_send_message", { content: "once", mentions: ["@owner"], operation_id: "op-1" });
      } finally {
        if (turns === 1) firstTurnEnded.resolve();
      }
    });
    // The first turn's post is in flight at Band when Band interrupts the turn.
    const post = room.holdMessage((content) => content === "once");
    const first = await room.say(OWNER, `${MENTION} one`);
    await post.sending;
    platform.control("interrupt", ROOM);
    await events.next((event) => event.type === "turn.stopped");
    post.release();
    await firstTurnEnded.promise;
    expect(await room.outcome(first)).toBe("processed");

    expect(await room.outcome(await room.say(OWNER, `${MENTION} two`))).toBe("processed");

    expect(room.messages.map((message) => message.content)).toEqual(["once"]);
    await runtime.stop();
  });

  it("refuses an operation id that is not a non-empty string, posting nothing", async () => {
    const results: unknown[] = [];
    const { room, runtime } = await agentReplying(async ({ tools }) => {
      results.push(await tools.executeToolCall("band_send_message", { content: "x", mentions: ["@owner"], operation_id: "" }));
      tools.turn.settle();
    });

    expect(await room.outcome(await room.say(OWNER, `${MENTION} hi`))).toBe("processed");

    expect(results[0]).toMatchObject({ ok: false });
    expect(room.messages).toEqual([]);
    await runtime.stop();
  });
});

const isStopped = (event: AgentEvent) => event.type === "turn.stopped";

/** A handler whose first turn posts `partial` and works until released; later turns answer at once. */
function firstTurnRepliesThenHangs() {
  const released = createDeferred();
  let turns = 0;
  const handler: Handler = async ({ tools }) => {
    turns += 1;
    if (turns === 1) {
      await tools.sendMessage("partial", ["@owner"]);
      await released.promise;
      return;
    }
    await tools.sendMessage("answered", ["@owner"]);
  };
  return { handler, release: () => released.resolve() };
}

describe("the turn journal when Band runs a message again", () => {
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
    expect(await journalLines(journalDir)).toEqual(["reply.intent", "reply.posted", "turn.retried"]);

    // Band still serves the failed message; the next process answers it.
    const second = await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.sendMessage("answered", ["@owner"]);
    });

    await platform.rest.settled.next((settled) => settled.messageId === inbound && settled.outcome === "processed");
    expect(room.outcomes(inbound)).toEqual(["failed", "processed"]);
    expect(second.handled).toEqual([inbound]);
    expect(room.messages.map((posted) => posted.content)).toEqual(["partial", "answered"]);
    await second.runtime.stop();
  });

  it("runs a stopped turn's message again on play, though the stopped turn had replied", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const { handler, release } = firstTurnRepliesThenHangs();
    const { runtime, handled, events } = await startProcess(platform, tmpRoot(), handler);
    const inbound = await room.say(OWNER, `${MENTION} hello`);
    await room.until(() => room.messages.length === 1);

    platform.control("stop", ROOM);
    await events.next(isStopped);
    release();
    platform.control("play", ROOM);

    expect(await room.outcome(inbound)).toBe("processed");
    expect(handled).toEqual([inbound, inbound]);
    expect(room.messages.map((posted) => posted.content)).toEqual(["partial", "answered"]);
    await runtime.stop();
  });

  it("records an interrupted turn as done before its message is consumed, so a restart does not run it", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const { handler, release } = firstTurnRepliesThenHangs();
    const { runtime, events } = await startProcess(platform, journalDir, handler);
    const inbound = await room.say(OWNER, `${MENTION} hello`);
    await room.until(() => room.messages.length === 1);
    const mark = room.holdNextProcessed();

    platform.control("interrupt", ROOM);
    await mark.sending;

    expect(await journalLines(journalDir)).toEqual(["reply.intent", "reply.posted", "turn.done"]);
    mark.release();
    expect(await room.outcome(inbound)).toBe("processed");
    await events.next(isStopped);
    release();
    await runtime.stop();
  });
});

describe("advertising operation_id", () => {
  async function schemasSeen(journalDir: string | undefined) {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const seen: Record<string, unknown>[] = [];
    const { runtime } = await startProcess(platform, journalDir, async ({ tools }) => {
      seen.push(
        ...tools.getAnthropicToolSchemas(),
        ...tools.getOpenAIToolSchemas(),
        ...tools.getToolSchemas("anthropic"),
        ...tools.getToolSchemas("openai"),
      );
      tools.turn.settle();
    });
    expect(await room.outcome(await room.say(OWNER, `${MENTION} hi`))).toBe("processed");
    await runtime.stop();
    const properties = (name: string) => seen
      .filter((schema) => schema.name === name || (schema.function as { name?: string } | undefined)?.name === name)
      .map((schema) => Object.keys(((schema.input_schema ?? (schema.function as { parameters: unknown }).parameters) as { properties: object }).properties));
    return { send: properties("band_send_message"), noReply: properties("band_no_reply"), event: properties("band_send_event") };
  }

  it("offers operation_id on the reply tools, in both schema formats, only to a journaled turn", async () => {
    const journaled = await schemasSeen(tmpRoot());
    const everyFormat = Array.from({ length: 4 }, () => expect.arrayContaining(["operation_id"]));
    expect(journaled.send).toEqual(everyFormat);
    expect(journaled.noReply).toEqual(everyFormat);
    expect(journaled.event.flat()).not.toContain("operation_id");

    const plain = await schemasSeen(undefined);
    expect(plain.send).toHaveLength(4);
    expect([...plain.send, ...plain.noReply].flat()).not.toContain("operation_id");
  });
});

describe("a turn journal that cannot be used", () => {
  it("fails start when journalDir is not a writable directory", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    await platform.room(ROOM);
    const file = path.join(tmpRoot(), "journal");
    await writeFile(file, "not a directory");

    await expect(startProcess(platform, file, async () => undefined)).rejects.toBeInstanceOf(ValidationError);
  });

  it("fails only the turn whose room journal cannot be read, and keeps the runtime and its other rooms running", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const other = await platform.room(OTHER_ROOM);
    const journalDir = tmpRoot();
    // The room's journal path is taken by a directory: opening it fails.
    await mkdir(journalFile(journalDir), { recursive: true });
    const { runtime, handled } = await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.sendMessage("answered", ["@owner"]);
    });

    const unreadable = await room.say(OWNER, `${MENTION} hello`);
    expect(await room.outcome(unreadable)).toBe("failed");
    const fine = await other.say(OWNER, `${MENTION} hello`);
    expect(await other.outcome(fine)).toBe("processed");

    expect(handled).toEqual([fine]);
    expect(runtime.state.status).toBe("running");
    await runtime.stop();
  });
});
