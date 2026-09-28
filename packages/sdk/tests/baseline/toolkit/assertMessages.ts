/**
 * Deterministic assertions on captured messages: substring and count checks,
 * never an LLM judge.
 */
import { expect } from "vitest";

import type { AgentIdentity } from "./agents";
import type { CapturedMessage, ReplyWait } from "./observeMessages";
import type { Room } from "./rooms";

/** Fails unless the wait captured a reply; narrows it to that reply. */
export function assertReplied(reply: ReplyWait): asserts reply is { kind: "reply"; message: CapturedMessage } {
  if (reply.kind === "timeout") {
    throw new Error(`no reply within ${reply.waitedMs}ms`);
  }
}

/** Fails unless the wait captured a reply containing `text`, ignoring case. */
export function assertReplyContains(reply: ReplyWait, text: string): void {
  assertReplied(reply);
  expect(reply.message.content.toLowerCase(), `reply does not contain "${text}"`).toContain(text.toLowerCase());
}

/** Fails unless the room captured exactly `count` messages, or `count` from `sender` when given. */
export function assertMessageCount(room: Pick<Room, "messages">, count: number, sender?: Pick<AgentIdentity, "id" | "name">): void {
  const messages = room.messages.entries.filter((message) => !sender || message.sender_id === sender.id);
  expect(messages, `captured messages${sender ? ` from ${sender.name}` : ""}`).toHaveLength(count);
}
