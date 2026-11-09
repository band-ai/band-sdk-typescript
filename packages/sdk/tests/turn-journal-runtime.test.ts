import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { GenericAdapter, type GenericAdapterHandler } from "../src/adapters/GenericAdapter";
import type { AgentEvent } from "../src/contracts/events";
import { isFailedToolOutput } from "../src/contracts/protocols";
import { relayReply } from "../src/core/turn";
import { PlatformRuntime } from "../src/runtime";
import { TurnJournal } from "../src/runtime/journal/TurnJournal";
import { AGENT_API_KEY, AGENT_ID, BandPlatform, person } from "./flows/support/bandPlatform";
import { tmpRoot } from "./testUtils";

const OWNER = "owner";
const ROOM = "room-1";
const MENTION = `@[[${AGENT_ID}]]`;

type Handler = GenericAdapterHandler;

/** One process of the agent: a runtime on `platform` journaling to `journalDir`. */
async function startProcess(platform: BandPlatform, journalDir: string, handler: Handler) {
  const handled: string[] = [];
  const events: AgentEvent[] = [];
  const runtime = new PlatformRuntime({
    agentId: AGENT_ID,
    apiKey: AGENT_API_KEY,
    linkOptions: platform.link,
    agentConfig: { autoSubscribeExistingRooms: true },
    sessionConfig: { journalDir },
  });
  runtime.observe((event) => {
    events.push(event);
  });
  await runtime.start(
    new GenericAdapter(async (args) => {
      handled.push(String(args.message.id));
      await handler(args);
    }),
  );
  return { runtime, handled, events };
}

async function journalLines(journalDir: string): Promise<string[]> {
  const text = await readFile(path.join(journalDir, `${ROOM}.jsonl`), "utf8");
  return text.split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { t: string }).t);
}

const replyPaths: Array<[string, Handler]> = [
  ["band_send_message", async ({ tools }) => {
    await tools.executeToolCall("band_send_message", { content: "answered", mentions: ["@owner"] });
  }],
  ["sendMessage", async ({ tools }) => {
    await tools.sendMessage("answered", ["@owner"]);
  }],
  ["the relayed closing text", async ({ tools }) => {
    await relayReply(tools, "answered", ["@owner"]);
  }],
  ["band_no_reply", async ({ tools }) => {
    await tools.executeToolCall("band_no_reply", { reason: "nothing to add" });
  }],
];

describe("the turn journal across a restart", () => {
  it.each(replyPaths)("journals %s at the same point and does not answer the inbound again after a restart that beat the processed mark", async (replyPath, answer) => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} hello`);
    // The process dies after its reply is posted and recorded, before Band hears it was processed:
    // its processed mark never completes, and it stops without waiting for it.
    const mark = platform.rest.processedHolds.hold((messageId) => messageId === inbound);
    const first = await startProcess(platform, journalDir, answer);
    await mark.sending;
    await first.runtime.stop(50);
    const postedBefore = room.posted.length;
    const recorded = replyPath === "band_no_reply" ? ["reply.declined"] : ["reply.intent", "reply.posted"];
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
    let firstSent: () => void = () => undefined;
    const sentFirst = new Promise<void>((resolve) => {
      firstSent = resolve;
    });
    const first = await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.executeToolCall("band_send_message", { content: "first", mentions: ["@owner"] });
      firstSent();
      // Killed here: the second reply is never sent.
      await new Promise<never>(() => undefined);
    });
    await sentFirst;
    await first.runtime.stop(50);
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

  it("dispatches nothing for an inbound whose turn ended before a restart", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} hello`);
    // A turn that ended without a reply journaled: it settled, or reported its failure.
    const ended = new TurnJournal(journalDir);
    await (await ended.room(ROOM)).turnDone(inbound);
    await ended.close();

    const { runtime, handled } = await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.sendMessage("answered", ["@owner"]);
    });

    expect(await room.outcome(inbound)).toBe("processed");
    expect(handled).toEqual([]);
    expect(room.posted).toEqual([]);
    await runtime.stop();
  });

  it("records the intent before posting, so a kill after Band accepts the post is reported, not silently reposted", async () => {
    const platform = BandPlatform.host([person(OWNER)]);
    const room = await platform.room(ROOM);
    const journalDir = tmpRoot();
    const inbound = room.postBeforeConnect(OWNER, `${MENTION} hello`);
    // Band accepts the post, then the process dies before the response reaches it.
    const createChatMessage = platform.rest.createChatMessage.bind(platform.rest);
    let accepted: () => void = () => undefined;
    const postAccepted = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    platform.rest.createChatMessage = async (...args) => {
      await createChatMessage(...args);
      accepted();
      return await new Promise<never>(() => undefined);
    };
    const answer: Handler = async ({ tools }) => {
      await tools.executeToolCall("band_send_message", { content: "answered", mentions: ["@owner"], operation_id: "op-1" });
    };
    const first = await startProcess(platform, journalDir, answer);
    await postAccepted;
    await first.runtime.stop(50);

    expect(room.messages.map((posted) => posted.content)).toEqual(["answered"]);
    expect(await journalLines(journalDir)).toEqual(["reply.intent"]);

    platform.rest.createChatMessage = createChatMessage;
    const second = await startProcess(platform, journalDir, answer);

    expect(await room.outcome(inbound)).toBe("processed");
    expect(second.events.filter((event) => event.type === "delivery.unrecorded")).toEqual([
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
    const crashed = new TurnJournal(journalDir);
    await (await crashed.room(ROOM)).beginReply(inbound, { tool: "band_send_message", digest: "d", operationId: "op-1" });
    await crashed.close();

    const { runtime, handled, events } = await startProcess(platform, journalDir, async ({ tools }) => {
      await tools.sendMessage("answered", ["@owner"]);
    });

    expect(await room.outcome(inbound)).toBe("processed");
    expect(handled).toEqual([inbound]);
    expect(events.filter((event) => event.type === "delivery.unrecorded")).toEqual([
      { type: "delivery.unrecorded", roomId: ROOM, messageId: inbound, operationId: "op-1" },
    ]);
    expect(await journalLines(journalDir)).toContain("delivery.unrecorded");
    await runtime.stop();
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

  it.each([
    ["band_send_message", { content: "changed", mentions: ["@owner"] }],
    ["band_no_reply", { reason: "changed" }],
  ] as const)("refuses %s under an id already used for different arguments, posting nothing", async (tool, changed) => {
    const results: unknown[] = [];
    const { room, runtime } = await agentReplying(async ({ tools }) => {
      const first = tool === "band_send_message" ? { content: "original", mentions: ["@owner"] } : { reason: "original" };
      results.push(await tools.executeToolCall(tool, { ...first, operation_id: "op-1" }));
      results.push(await tools.executeToolCall(tool, { ...changed, operation_id: "op-1" }));
    });

    expect(await room.outcome(await room.say(OWNER, `${MENTION} hi`))).toBe("processed");

    expect(isFailedToolOutput(results[0])).toBe(false);
    expect(results[1]).toMatchObject({ ok: false, message: expect.stringContaining("op-1") });
    expect(room.messages.map((posted) => posted.content)).toEqual(tool === "band_send_message" ? ["original"] : []);
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
