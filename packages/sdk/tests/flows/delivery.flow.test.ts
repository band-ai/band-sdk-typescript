/**
 * How a turn's message posts are delivered, through the real platform runtime:
 * each is anchored at the turn's trigger so its post can be read back, and a
 * `band_send_message` call the model repeats does not post twice.
 */
import { BandError } from "@band-ai/rest-client";
import { describe, expect, it } from "vitest";

import { GenericAdapter } from "../../src/adapters/GenericAdapter";
import { isToolExecutorError, type AdapterToolsProtocol, type FrameworkAdapter } from "../../src/contracts/protocols";
import { SEND_MESSAGE_TOOL_NAME } from "../../src/contracts/toolSchemas";
import { DeliveryFailedError, DeliveryUnknownError, deliverReply } from "../../src/core/deliveryFailedError";
import { tmpRoot } from "../testUtils";
import { IDENTITY } from "../turnJournalSupport";
import { AGENT_ID, BandPlatform, person, RecordingRestApi } from "./support/bandPlatform";

const ADA = person("ada");
const BEN = person("ben");
const ASK = `@[[${AGENT_ID}]] hi`;

function sendTool(tools: AdapterToolsProtocol, content: string, mentions: unknown[] = [ADA.id]): Promise<unknown> {
  return tools.executeToolCall(SEND_MESSAGE_TOOL_NAME, { content, mentions });
}

/** A 503: Band may hold the post, and cannot say. */
function serverError(): BandError {
  return new BandError({ statusCode: 503, body: { error: { code: "server_error", message: "Service unavailable", request_id: "req-1" } } });
}

/** A 403: Band answered and saved nothing. */
function forbidden(): BandError {
  return new BandError({ statusCode: 403, body: { error: { code: "forbidden", message: "Forbidden", request_id: "req-2" } } });
}

/** The agent in a room with Ada and Ben, journaling its replies so an unknown delivery stands classified. */
async function journaled(adapter: FrameworkAdapter) {
  const platform = await BandPlatform.start(adapter, [ADA, BEN], undefined, { journalDir: tmpRoot(), journalPlatformIdentity: IDENTITY });
  const room = await platform.room("room-1");
  return { platform, room, [Symbol.asyncDispose]: () => platform[Symbol.asyncDispose]() };
}

/** Every message post the agent attempted, whether or not Band kept it. */
function attempts(platform: BandPlatform): string[] {
  return platform.rest.deliveries.map(({ content }) => content);
}

function publicationOf(result: unknown): unknown {
  return isToolExecutorError(result) ? result.details?.publicationId : undefined;
}

describe("Message delivery in a Band room", () => {
  it("anchors every post of a turn at its trigger, as the agent's own: notices, tool calls and direct replies", async () => {
    const adapter = new GenericAdapter(async ({ tools }) => {
      await tools.sendNotice("working on it", [ADA.id]);
      await sendTool(tools, "by tool");
      await tools.sendMessage("by method", [ADA.id]);
    });
    await using session = await BandPlatform.join(adapter, [ADA]);

    const trigger = await session.room.say(ADA.id, ASK);
    await session.room.outcome(trigger);

    expect(session.platform.rest.deliveries.map(({ content, delivery }) => [content, delivery?.selfId, delivery?.anchor.id])).toEqual([
      ["working on it", AGENT_ID, trigger],
      ["by tool", AGENT_ID, trigger],
      ["by method", AGENT_ID, trigger],
    ]);
  });

  it("answers a repeated send in flight with the first one's result, and lets a retry after its failure post", async () => {
    const outcomes: unknown[] = [];
    const adapter = new GenericAdapter(async ({ tools }) => {
      const first = sendTool(tools, "once");
      await held.sending;
      const repeat = sendTool(tools, "once");
      held.release();
      outcomes.push(await first, await repeat, await sendTool(tools, "once"));
    });
    await using session = await BandPlatform.join(adapter, [ADA]);
    const held = session.room.holdMessage((content) => content === "once", { error: new Error("connection reset") });

    await session.room.outcome(await session.room.say(ADA.id, ASK));

    const [first, repeat, retry] = outcomes;
    expect(repeat).toBe(first);
    expect(isToolExecutorError(first)).toBe(true);
    expect(isToolExecutorError(retry)).toBe(false);
    expect(session.room.messages.map(({ content }) => content)).toEqual(["once"]);
  });

  it("answers a send repeated after it posted with the first one's result", async () => {
    const outcomes: unknown[] = [];
    const adapter = new GenericAdapter(async ({ tools }) => {
      outcomes.push(await sendTool(tools, "once"), await sendTool(tools, "once"));
    });
    await using session = await BandPlatform.join(adapter, [ADA]);

    await session.room.outcome(await session.room.say(ADA.id, ASK));

    expect(outcomes[1]).toBe(outcomes[0]);
    expect(session.room.messages.map(({ content }) => content)).toEqual(["once"]);
  });

  it("posts a repeated direct reply each time: only the model's tool calls are deduplicated", async () => {
    const adapter = new GenericAdapter(async ({ tools }) => {
      await tools.sendMessage("again", [ADA.id]);
      await tools.sendMessage("again", [ADA.id]);
    });
    await using session = await BandPlatform.join(adapter, [ADA]);

    await session.room.outcome(await session.room.say(ADA.id, ASK));

    expect(session.room.messages.map(({ content }) => content)).toEqual(["again", "again"]);
  });

  it("posts same-content replies in flight to two peers who share a display name", async () => {
    const alex1 = { ...person("alex-1"), name: "Alex" };
    const alex2 = { ...person("alex-2"), name: "Alex" };
    const adapter = new GenericAdapter(async ({ tools }) => {
      await Promise.all([
        tools.sendMessage("Thanks!", [{ id: alex1.id, name: "Alex" }]),
        tools.sendMessage("Thanks!", [{ id: alex2.id, name: "Alex" }]),
      ]);
    });
    await using session = await BandPlatform.join(adapter, [alex1, alex2]);

    await session.room.outcome(await session.room.say(alex1.id, ASK));

    expect(session.room.messages.map(({ mentions }) => mentions)).toEqual([[alex1.id], [alex2.id]]);
  });

  it("credits a fresh session's own posts in history, so none is taken for its new replies", async () => {
    const rest = new RecordingRestApi([ADA]);
    const replying = () => new GenericAdapter(async ({ tools }) => {
      await tools.sendMessage("Done", [ADA.id]);
    });
    {
      await using first = await BandPlatform.join(replying(), [ADA], { rest });
      await first.room.outcome(await first.room.say(ADA.id, ASK));
    }
    const { data: history } = await rest.getChatContext({ chatId: "room-1" });
    const earlierReply = history.find(({ sender_id }) => sender_id === AGENT_ID)?.id;

    await using restarted = await BandPlatform.join(replying(), [ADA], { rest });
    await restarted.room.outcome(await restarted.room.say(ADA.id, ASK));

    expect(earlierReply).toBeDefined();
    expect(rest.deliveries.at(-1)?.delivery?.attributed.has(earlierReply!)).toBe(true);
  });
});

describe("A reply whose delivery is unknown is never posted twice", () => {
  it("answers the model's repeated send with the first result, however its mentions are spelled", async () => {
    const outcomes: unknown[] = [];
    const adapter = new GenericAdapter(async ({ tools }) => {
      outcomes.push(await sendTool(tools, "held", ["@ada", "@ben"]));
      outcomes.push(await sendTool(tools, "held", [{ id: BEN.id, handle: "BEN" }, "ada", "@ada"]));
    });
    await using session = await journaled(adapter);
    session.room.holdMessage((content) => content === "held", { error: serverError() }).release();

    await session.room.outcome(await session.room.say(ADA.id, ASK));

    const [first, repeat] = outcomes;
    expect(first).toMatchObject({ details: { kind: DeliveryUnknownError.KIND } });
    expect(repeat).toBe(first);
    expect(attempts(session.platform)).toEqual(["held"]);
  });

  it("rejects a direct reply after the model's unknown send as unknown, naming the same publication", async () => {
    const outcomes: unknown[] = [];
    const adapter = new GenericAdapter(async ({ tools }) => {
      outcomes.push(await sendTool(tools, "held"));
      outcomes.push(await deliverReply(tools, "held", [ADA.id]).catch((error: unknown) => error));
    });
    await using session = await journaled(adapter);
    session.room.holdMessage((content) => content === "held", { error: serverError() }).release();

    await session.room.outcome(await session.room.say(ADA.id, ASK));

    const [viaTool, viaReply] = outcomes;
    expect(viaReply).toBeInstanceOf(DeliveryUnknownError);
    expect((viaReply as DeliveryUnknownError).publicationId).toBe(publicationOf(viaTool));
    expect(attempts(session.platform)).toEqual(["held"]);
  });

  it("answers the model's send after a direct reply's unknown delivery with that delivery, not a throw", async () => {
    const outcomes: unknown[] = [];
    const adapter = new GenericAdapter(async ({ tools }) => {
      outcomes.push(await deliverReply(tools, "held", [ADA.id]).catch((error: unknown) => error));
      outcomes.push(await sendTool(tools, "held"));
    });
    await using session = await journaled(adapter);
    session.room.holdMessage((content) => content === "held", { error: serverError() }).release();

    await session.room.outcome(await session.room.say(ADA.id, ASK));

    const [viaReply, viaTool] = outcomes;
    expect(viaReply).toBeInstanceOf(DeliveryUnknownError);
    expect(viaTool).toMatchObject({ details: { kind: DeliveryUnknownError.KIND } });
    expect(publicationOf(viaTool)).toBe((viaReply as DeliveryUnknownError).publicationId);
    expect(attempts(session.platform)).toEqual(["held"]);
  });

  it("joins a direct reply to the model's send in flight, and both learn the delivery is unknown", async () => {
    const outcomes: unknown[] = [];
    const adapter = new GenericAdapter(async ({ tools }) => {
      const viaTool = sendTool(tools, "race");
      await held.sending;
      const viaReply = deliverReply(tools, "race", [ADA.id]).catch((error: unknown) => error);
      held.release();
      outcomes.push(await viaTool, await viaReply);
    });
    await using session = await journaled(adapter);
    const held = session.room.holdMessage((content) => content === "race", { error: serverError() });

    await session.room.outcome(await session.room.say(ADA.id, ASK));

    const [viaTool, viaReply] = outcomes;
    expect(viaTool).toMatchObject({ details: { kind: DeliveryUnknownError.KIND } });
    expect(viaReply).toBeInstanceOf(DeliveryUnknownError);
    expect(attempts(session.platform)).toEqual(["race"]);
  });

  it("still refuses a resend the coalescer cannot recognize: the turn's fence holds it", async () => {
    const outcomes: unknown[] = [];
    const adapter = new GenericAdapter(async ({ tools }) => {
      outcomes.push(await sendTool(tools, "held", ["@ada"]));
      // An id-only mention names Ada too, but without the roster it is another key.
      outcomes.push(await sendTool(tools, "held", [{ id: ADA.id }]));
    });
    await using session = await journaled(adapter);
    session.room.holdMessage((content) => content === "held", { error: serverError() }).release();

    await session.room.outcome(await session.room.say(ADA.id, ASK));

    expect(outcomes[1]).toMatchObject({ details: { kind: "fenced" } });
    expect(attempts(session.platform)).toEqual(["held"]);
  });
});

describe("A reply and a model send of the same content in one turn", () => {
  it("post once when the reply joins the model's send in flight", async () => {
    const outcomes: unknown[] = [];
    const adapter = new GenericAdapter(async ({ tools }) => {
      const viaTool = sendTool(tools, "race");
      await held.sending;
      const viaReply = deliverReply(tools, "race", [ADA.id]);
      held.release();
      outcomes.push(await viaTool, await viaReply);
    });
    await using session = await BandPlatform.join(adapter, [ADA]);
    const held = session.room.holdMessage((content) => content === "race");

    await session.room.outcome(await session.room.say(ADA.id, ASK));

    expect(outcomes[1]).toBe(outcomes[0]);
    expect(session.room.messages.map(({ content }) => content)).toEqual(["race"]);
  });

  it("post twice when the reply follows the model's send that already posted", async () => {
    const adapter = new GenericAdapter(async ({ tools }) => {
      await sendTool(tools, "same");
      await deliverReply(tools, "same", [ADA.id]);
    });
    await using session = await BandPlatform.join(adapter, [ADA]);

    await session.room.outcome(await session.room.say(ADA.id, ASK));

    expect(session.room.messages.map(({ content }) => content)).toEqual(["same", "same"]);
  });

  it("never reports a reply as posted when the model's send it joined was refused", async () => {
    const outcomes: unknown[] = [];
    const adapter = new GenericAdapter(async ({ tools }) => {
      const viaTool = sendTool(tools, "refused");
      await held.sending;
      const viaReply = deliverReply(tools, "refused", [ADA.id]).catch((error: unknown) => error);
      held.release();
      outcomes.push(await viaTool, await viaReply);
    });
    await using session = await BandPlatform.join(adapter, [ADA]);
    const held = session.room.holdMessage((content) => content === "refused", { error: forbidden() });

    await session.room.outcome(await session.room.say(ADA.id, ASK));

    const [viaTool, viaReply] = outcomes;
    expect(isToolExecutorError(viaTool)).toBe(true);
    expect(viaReply).toBeInstanceOf(DeliveryFailedError);
    expect(viaReply).not.toBeInstanceOf(DeliveryUnknownError);
    expect(session.room.messages).toEqual([]);
  });

  it("answers the model's send that joined a refused reply with a tool result, never a throw", async () => {
    const outcomes: unknown[] = [];
    const adapter = new GenericAdapter(async ({ tools }) => {
      const viaReply = deliverReply(tools, "refused", [ADA.id]).catch((error: unknown) => error);
      await held.sending;
      const viaTool = sendTool(tools, "refused").catch((error: unknown) => ({ threw: error }));
      held.release();
      outcomes.push(await viaReply, await viaTool);
    });
    await using session = await BandPlatform.join(adapter, [ADA]);
    const held = session.room.holdMessage((content) => content === "refused", { error: forbidden() });

    await session.room.outcome(await session.room.say(ADA.id, ASK));

    const [viaReply, viaTool] = outcomes;
    expect(viaReply).toBeInstanceOf(DeliveryFailedError);
    expect(viaTool).toMatchObject({ ok: false, toolName: SEND_MESSAGE_TOOL_NAME, errorType: "ToolExecutionError" });
    expect(attempts(session.platform)).toEqual(["refused"]);
  });
});
