import { describe, expect, it } from "vitest";

import type { MessageCreatedPayload } from "../../../src/platform/events";
import { RecordLog } from "../../testUtils";
import { assertMessageCount, assertReplied, assertReplyContains, assertToolFired } from "./assertMessages";
import { MESSAGE_TYPE, REPLY_WAIT, type ReplyWait, type ToolCallEvent } from "./observeMessages";

const REPLY_WORD = "pineapple";

const reply = (content: string): ReplyWait => ({
  kind: REPLY_WAIT.reply,
  message: { id: "m1", content, senderId: "agent", messageType: MESSAGE_TYPE.Text, mentionIds: ["user"], metadata: {} },
});

function roomWith(...senderIds: string[]) {
  const messages = new RecordLog<MessageCreatedPayload>();
  senderIds.forEach((senderId, index) =>
    messages.record({
      id: `m${index}`,
      content: "hi",
      message_type: MESSAGE_TYPE.Text,
      sender_id: senderId,
      sender_type: "Agent",
      inserted_at: "",
      updated_at: "",
    }),
  );
  return { messages };
}

const sender = { id: "agent", name: "e2e-ts-agent" } as const;

describe("assertReplyContains", () => {
  it("passes on a case-insensitive substring", () => {
    expect(() => assertReplyContains(reply(`Sure — ${REPLY_WORD.toUpperCase()} it is`), REPLY_WORD)).not.toThrow();
  });

  it("fails when the reply lacks the text", () => {
    expect(() => assertReplyContains(reply("mango"), REPLY_WORD)).toThrow(`reply does not contain "${REPLY_WORD}"`);
  });

  it("fails naming the wait when no reply came", () => {
    expect(() => assertReplyContains({ kind: REPLY_WAIT.timeout, waitedMs: 5, unmatched: [], failures: [] }, REPLY_WORD)).toThrow("no reply within 5ms");
  });

  it("names what the agent reported failing while no reply came", () => {
    const timedOut = { kind: REPLY_WAIT.timeout, waitedMs: 5, unmatched: [], failures: ["ACP turn ended with stop reason: cancelled."] };
    expect(() => assertReplied(timedOut)).toThrow("no reply within 5ms; the agent reported: ACP turn ended with stop reason: cancelled.");
  });

  it("names what the agent posted when none of it matched", () => {
    const timedOut = { kind: REPLY_WAIT.timeout, waitedMs: 5, unmatched: ["hello", "what now?"], failures: [] };
    expect(() => assertReplied(timedOut)).toThrow('no reply within 5ms; it posted instead: "hello" | "what now?"');
  });
});

describe("assertMessageCount", () => {
  const room = roomWith("user", "agent", "agent");

  it.each([
    { name: "counts every captured message", count: 3, from: undefined },
    { name: "counts one sender's messages", count: 2, from: sender },
  ])("$name", ({ count, from }) => {
    expect(() => assertMessageCount(room, count, from)).not.toThrow();
  });

  it("fails on a different count, naming the sender", () => {
    expect(() => assertMessageCount(room, 1, sender)).toThrow(/captured messages from e2e-ts-agent/);
  });
});

describe("assertToolFired", () => {
  const TOOL = "lookup_access_code";
  const ARG = "key";
  const call = (args: Record<string, unknown>, name = TOOL): ToolCallEvent => ({ id: `${name}-event`, name, args });

  it("passes on the name alone, ignoring case", () => {
    expect(() => assertToolFired([call({})], TOOL.toUpperCase())).not.toThrow();
  });

  it.each([
    { rule: "a string as a case-insensitive substring", expected: "alph", actual: "Alpha" },
    { rule: "an empty string to an empty string", expected: "", actual: "" },
    { rule: "a string to a non-string by its text", expected: "2", actual: 2 },
    { rule: "a non-string by equality", expected: 2, actual: 2 },
    { rule: "an object by deep equality", expected: { a: [1] }, actual: { a: [1] } },
    { rule: "a null expectation to a null value", expected: null, actual: null },
  ])("matches $rule", ({ expected, actual }) => {
    expect(() => assertToolFired([call({ [ARG]: actual })], TOOL, { [ARG]: expected })).not.toThrow();
  });

  it.each([
    { rule: "a string that is not a substring", expected: "beta", actual: "Alpha" },
    { rule: "an empty string against a non-empty one", expected: "", actual: "Alpha" },
    { rule: "an empty string against a non-string", expected: "", actual: [] },
    { rule: "a string to a non-string of other text", expected: "2", actual: 3 },
    { rule: "a non-string to a different value", expected: 2, actual: 3 },
    { rule: "a non-string to its own text", expected: 2, actual: "2" },
    { rule: "a non-null expectation to a null value", expected: "alpha", actual: null },
  ])("does not match $rule", ({ expected, actual }) => {
    expect(() => assertToolFired([call({ [ARG]: actual })], TOOL, { [ARG]: expected })).toThrow("expected a call to");
  });

  it("does not match an argument the call never passed", () => {
    expect(() => assertToolFired([call({})], TOOL, { [ARG]: null })).toThrow("expected a call to");
  });

  it("checks a subset of the args, and any one of the calls may satisfy it", () => {
    const calls = [call({ [ARG]: "beta" }), call({ [ARG]: "alpha", note: "urgent" })];
    expect(() => assertToolFired(calls, TOOL, { [ARG]: "alpha" })).not.toThrow();
  });

  it("fails on another tool's call, listing the calls that did fire", () => {
    const other = call({ [ARG]: "alpha" }, "get_forecast");
    expect(() => assertToolFired([other], TOOL, { [ARG]: "alpha" })).toThrow(
      `the calls that fired: get_forecast({"${ARG}":"alpha"})`,
    );
  });

  it("says none fired when there were no calls", () => {
    expect(() => assertToolFired([], TOOL)).toThrow("the calls that fired: none");
  });
});
