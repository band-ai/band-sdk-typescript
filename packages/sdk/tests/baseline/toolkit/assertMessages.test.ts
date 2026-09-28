import { describe, expect, it } from "vitest";

import type { MessageCreatedPayload } from "../../../src/platform/events";
import { RecordLog } from "../../testUtils";
import { assertMessageCount, assertReplied, assertReplyContains } from "./assertMessages";
import { MESSAGE_TYPE, REPLY_WAIT, type ReplyWait } from "./observeMessages";

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
    expect(() => assertReplyContains({ kind: REPLY_WAIT.timeout, waitedMs: 5, failures: [] }, REPLY_WORD)).toThrow("no reply within 5ms");
  });

  it("names what the agent reported failing while no reply came", () => {
    const timedOut = { kind: REPLY_WAIT.timeout, waitedMs: 5, failures: ["ACP turn ended with stop reason: cancelled."] };
    expect(() => assertReplied(timedOut)).toThrow("no reply within 5ms; the agent reported: ACP turn ended with stop reason: cancelled.");
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
