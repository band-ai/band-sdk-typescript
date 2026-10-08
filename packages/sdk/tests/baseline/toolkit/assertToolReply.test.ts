import { describe, expect, it } from "vitest";

import { SEND_MESSAGE_TOOL_NAME } from "../../../src/contracts/toolSchemas";
import { assertToolReply } from "./assertToolReply";
import { MESSAGE_TYPE, readToolCalls, readToolResults, type CapturedMessage } from "./observeMessages";

const expected = { marker: "pineapple", senderId: "agent", recipientId: "user" };
const message = (id: string, type: string, content: unknown): CapturedMessage => ({
  id, messageType: type, content: typeof content === "string" ? content : JSON.stringify(content),
  senderId: "agent", mentionIds: ["user"], metadata: {},
});
const calls = readToolCalls([message("call-event", MESSAGE_TYPE.ToolCall, {
  name: SEND_MESSAGE_TOOL_NAME, tool_call_id: "call", args: { content: "pineapple", mentions: ["user-handle"] },
})]);
const result = (output: unknown, is_error = false) => readToolResults([message("result-event", MESSAGE_TYPE.ToolResult, {
  name: SEND_MESSAGE_TOOL_NAME, tool_call_id: "call", output, is_error,
})]);
const reply = message("reply", MESSAGE_TYPE.Text, "@[[user]] pineapple");

describe("send-tool delivery proof", () => {
  it("accepts a successful structured result matching the persisted reply", () => {
    assertToolReply(calls, result({ success: true, id: "reply" }), [reply], expected);
    expect(calls[0]?.toolCallId).toBe("call");
    expect(result({ success: true, id: "reply" })[0]?.output).toEqual({ success: true, id: "reply" });
  });

  it("correlates content after the platform resolves inline handles to UUID mentions", () => {
    const inlineCalls = calls.map((call) => ({ ...call, args: { ...call.args, content: "@user-handle pineapple" } }));
    const normalizedReply = { ...reply, metadata: { mentions: [{ id: "user", handle: "user-handle" }] } };
    assertToolReply(inlineCalls, result({ success: true, id: "reply" }), [normalizedReply], expected);
    expect(() => assertToolReply(inlineCalls, result({ success: true, id: "reply" }),
      [{ ...normalizedReply, content: "@[[user]] a different pineapple reply" }], expected)).toThrow("successful send-tool");
  });

  it.each([undefined, {}, { id: "reply" }, { success: false, id: "reply" }, { success: true, id: "missing" },
    { ok: false, message: "cannot_mention_self" }, { error: "provider error" }])
    ("rejects absent, malformed, unmatched or failed results: %j", (output) => {
      expect(() => assertToolReply(calls, result(output), [reply], expected)).toThrow("successful send-tool");
    });

  it("rejects marker-bearing fallback after a rejected self-send", () => {
    const fallback = { ...reply, content: 'I sent "pineapple" but cannot mention myself.' };
    expect(() => assertToolReply(calls, result({ ok: false, message: "422 cannot_mention_self" }), [fallback], expected))
      .toThrow("successful send-tool");
  });

  it("rejects wrong call IDs, explicit errors, wrong recipients and duplicate narration", () => {
    const success = result({ success: true, id: "reply" });
    expect(() => assertToolReply(calls, [{ ...success[0]!, toolCallId: "other" }], [reply], expected)).toThrow();
    expect(() => assertToolReply(calls, result({ success: true, id: "reply" }, true), [reply], expected)).toThrow();
    expect(() => assertToolReply(calls, success, [{ ...reply, mentionIds: ["agent"] }], expected)).toThrow();
    expect(() => assertToolReply(calls, success, [reply, message("closing", MESSAGE_TYPE.Text, "I sent it.")], expected))
      .toThrow("exactly one");
  });
});
