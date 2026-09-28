import { describe, expect, it } from "vitest";

import type { MessageCreatedPayload } from "../../../src/platform/events";
import { RecordLog } from "../../testUtils";
import { assertMessageCount, assertReplyContains } from "./assertMessages";
import type { ReplyWait } from "./observeMessages";

const reply = (content: string): ReplyWait => ({
  kind: "reply",
  message: { id: "m1", content, senderId: "agent", messageType: "text", mentionIds: ["user"], metadata: {} },
});

function roomWith(...senderIds: string[]) {
  const messages = new RecordLog<MessageCreatedPayload>();
  senderIds.forEach((senderId, index) =>
    messages.record({
      id: `m${index}`,
      content: "hi",
      message_type: "text",
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
    expect(() => assertReplyContains(reply("Sure — PINEAPPLE it is"), "pineapple")).not.toThrow();
  });

  it("fails when the reply lacks the text", () => {
    expect(() => assertReplyContains(reply("mango"), "pineapple")).toThrow(/reply does not contain "pineapple"/);
  });

  it("fails naming the wait when no reply came", () => {
    expect(() => assertReplyContains({ kind: "timeout", waitedMs: 5 }, "pineapple")).toThrow("no reply within 5ms");
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
