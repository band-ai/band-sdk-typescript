import { describe, expect, it } from "vitest";

import { deliverFallbackReply, trackPostedReply } from "../src/runtime/tools/postedReply";
import { FakeTools } from "./testUtils";

const MENTION = [{ id: "user-1" }];

function trackedTools(execute: FakeTools["executeToolCall"] = async () => ({ ok: true }), onPost?: (content: string) => void) {
  const tools = new FakeTools();
  tools.executeToolCall = execute;
  return { tools, reply: trackPostedReply(tools, onPost) };
}

describe("trackPostedReply", () => {
  it.each([
    { name: "band_send_message", result: { ok: true }, posted: true },
    { name: "band_send_message", result: { ok: true }, content: "", posted: false },
    { name: "band_send_message", result: { ok: false, message: "unknown mention" }, posted: false },
    { name: "band_send_message", result: "Error: room gone", posted: false },
    { name: "band_get_participants", result: { ok: true }, posted: false },
  ])("$name returning $result posted: $posted", async ({ name, result, posted, content = "Hi" }) => {
    const posts: string[] = [];
    const { reply } = trackedTools(async () => result, (content) => posts.push(content));
    await reply.tools.executeToolCall(name, { content, mentions: ["@user"] });
    expect(reply.posted()).toBe(posted);
    expect(posts).toEqual(posted ? [content] : []);
  });

  it("does not count a send that threw", async () => {
    const { reply } = trackedTools(async () => {
      throw new Error("transport down");
    });
    await expect(reply.tools.executeToolCall("band_send_message", { content: "Hi" })).rejects.toThrow("transport down");
    expect(reply.posted()).toBe(false);
  });
});

describe("deliverFallbackReply", () => {
  it("delivers the final text when the turn posted nothing", async () => {
    const { tools, reply } = trackedTools();
    expect(await deliverFallbackReply(reply, "Final answer", MENTION)).toBe(true);
    expect(tools.messages).toEqual(["Final answer"]);
  });

  it("drops the final text once the turn posted its reply", async () => {
    const { tools, reply } = trackedTools();
    await reply.tools.executeToolCall("band_send_message", { content: "Hi" });
    expect(await deliverFallbackReply(reply, "I posted it.", MENTION)).toBe(false);
    expect(tools.messages).toEqual([]);
  });

  it.each(["", null, undefined])("delivers nothing for empty text (%o)", async (text) => {
    const { tools, reply } = trackedTools();
    expect(await deliverFallbackReply(reply, text, MENTION)).toBe(false);
    expect(tools.messages).toEqual([]);
  });
});
