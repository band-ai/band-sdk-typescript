/**
 * How a turn's message posts are delivered, through the real platform runtime:
 * each is anchored at the turn's trigger so its post can be read back, and a
 * `band_send_message` call the model repeats does not post twice.
 */
import { describe, expect, it } from "vitest";

import { GenericAdapter } from "../../src/adapters/GenericAdapter";
import { isToolExecutorError, type AdapterToolsProtocol } from "../../src/contracts/protocols";
import { SEND_MESSAGE_TOOL_NAME } from "../../src/contracts/toolSchemas";
import { AGENT_ID, BandPlatform, person, RecordingRestApi } from "./support/bandPlatform";

const ADA = person("ada");
const ASK = `@[[${AGENT_ID}]] hi`;

function sendTool(tools: AdapterToolsProtocol, content: string): Promise<unknown> {
  return tools.executeToolCall(SEND_MESSAGE_TOOL_NAME, { content, mentions: [ADA.id] });
}

describe("Message delivery in a Band room", () => {
  it("anchors every post of a turn at its trigger: notices, tool calls and direct replies", async () => {
    const adapter = new GenericAdapter(async ({ tools }) => {
      await tools.sendNotice("working on it", [ADA.id]);
      await sendTool(tools, "by tool");
      await tools.sendMessage("by method", [ADA.id]);
    });
    await using session = await BandPlatform.join(adapter, [ADA]);

    const trigger = await session.room.say(ADA.id, ASK);
    await session.room.outcome(trigger);

    expect(session.platform.rest.deliveries.map(({ content, delivery }) => [content, delivery?.anchor.id])).toEqual([
      ["working on it", trigger],
      ["by tool", trigger],
      ["by method", trigger],
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
