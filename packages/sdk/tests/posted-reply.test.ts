import { describe, expect, it } from "vitest";

import { deliverFallbackReply, trackPostedReply } from "../src/runtime/tools/postedReply";
import { FakeTools } from "./testUtils";

const MENTION = [{ id: "user-1" }];

function trackedTools(result: unknown) {
  const tools = new FakeTools();
  tools.executeToolCall = async () => result;
  return { tools, reply: trackPostedReply(tools) };
}

describe("trackPostedReply", () => {
  it.each([
    { name: "band_send_message", result: { ok: true }, posted: true },
    { name: "band_send_message", result: { ok: false, message: "unknown mention" }, posted: false },
    { name: "band_send_message", result: "Error: room gone", posted: false },
    { name: "band_get_participants", result: { ok: true }, posted: false },
  ])("$name returning $result posted: $posted", async ({ name, result, posted }) => {
    const { reply } = trackedTools(result);
    await reply.tools.executeToolCall(name, { content: "Hi", mentions: ["@user"] });
    expect(reply.posted()).toBe(posted);
  });

  it("does not count a send that threw", async () => {
    const tools = new FakeTools();
    tools.executeToolCall = async () => {
      throw new Error("transport down");
    };
    const reply = trackPostedReply(tools);
    await expect(reply.tools.executeToolCall("band_send_message", { content: "Hi" })).rejects.toThrow("transport down");
    expect(reply.posted()).toBe(false);
  });
});

describe("deliverFallbackReply", () => {
  it("delivers the final text when the turn posted nothing", async () => {
    const { tools, reply } = trackedTools({ ok: true });
    expect(await deliverFallbackReply(reply, "Final answer", MENTION)).toBe(true);
    expect(tools.messages).toEqual(["Final answer"]);
  });

  it("drops the final text once the turn posted its reply", async () => {
    const { tools, reply } = trackedTools({ ok: true });
    await reply.tools.executeToolCall("band_send_message", { content: "Hi" });
    expect(await deliverFallbackReply(reply, "I posted it.", MENTION)).toBe(false);
    expect(tools.messages).toEqual([]);
  });

  it.each(["", null, undefined])("delivers nothing for empty text (%o)", async (text) => {
    const { tools, reply } = trackedTools({ ok: true });
    expect(await deliverFallbackReply(reply, text, MENTION)).toBe(false);
    expect(tools.messages).toEqual([]);
  });
});
