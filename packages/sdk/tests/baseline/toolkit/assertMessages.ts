/**
 * Deterministic assertions on captured messages and the tool calls stored with
 * them: substring, count and argument checks, never an LLM judge.
 */
import { isDeepStrictEqual } from "node:util";

import { expect } from "vitest";

import type { AgentIdentity } from "./agents";
import { REPLY_WAIT, type CapturedMessage, type ReplyWait, type ToolCallEvent } from "./observeMessages";
import type { Room } from "./rooms";

/** Fails unless the wait captured a reply; narrows it to that reply. */
export function assertReplied(reply: ReplyWait): asserts reply is { kind: typeof REPLY_WAIT.reply; message: CapturedMessage } {
  if (reply.kind === REPLY_WAIT.timeout) {
    const posted = reply.unmatched.length > 0 ? `; it posted instead: ${reply.unmatched.map((text) => JSON.stringify(text)).join(" | ")}` : "";
    const reported = reply.failures.length > 0 ? `; the agent reported: ${reply.failures.join(" | ")}` : "";
    throw new Error(`no reply within ${reply.waitedMs}ms${posted}${reported}`);
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

/**
 * Whether an argument `actual` satisfies what a scenario `expected`, tolerant of
 * how a model phrases it: strings match as a case-insensitive substring, except
 * that an empty expectation matches only an empty string; a missing value matches
 * only a missing expectation; anything else must be equal, a non-string actual
 * compared to a string expectation by its text.
 */
function tolerantMatch(expected: unknown, actual: unknown): boolean {
  if (expected == null || actual == null) {
    return expected == null && actual == null;
  }
  if (expected === "") {
    return actual === "";
  }
  if (typeof expected !== "string") {
    return isDeepStrictEqual(expected, actual);
  }
  if (typeof actual !== "string") {
    return expected === String(actual);
  }
  return actual.toLowerCase().includes(expected.toLowerCase());
}

const describeCall = ({ name, args }: ToolCallEvent): string => `${name}(${JSON.stringify(args)})`;

/**
 * Fails unless a call to `name` (ignoring case) fired whose args include every
 * entry of `withArgs`, each matched tolerantly. Extra args on the call are fine.
 */
export function assertToolFired(calls: readonly ToolCallEvent[], name: string, withArgs: Record<string, unknown> = {}): void {
  const fired = calls.some(
    (call) =>
      call.name.toLowerCase() === name.toLowerCase() &&
      Object.entries(withArgs).every(([key, expected]) => key in call.args && tolerantMatch(expected, call.args[key])),
  );
  const wanted = Object.keys(withArgs).length > 0 ? `${name} with ${JSON.stringify(withArgs)}` : name;
  expect(fired, `expected a call to ${wanted}; the calls that fired: ${calls.map(describeCall).join(", ") || "none"}`).toBe(true);
}
