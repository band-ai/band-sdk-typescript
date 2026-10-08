import { expect } from "vitest";

import { SEND_MESSAGE_TOOL_NAME } from "../../../src/contracts/toolSchemas";
import { parseToolPayload } from "../../../src/converters/shared";
import type { CapturedMessage, ToolCallEvent, ToolResultEvent } from "./observeMessages";

/** A returned message ID proves delivery only when it identifies the actual room reply. */
export function assertToolReply(
  calls: readonly ToolCallEvent[],
  results: readonly ToolResultEvent[],
  replies: readonly CapturedMessage[],
  expected: { marker: string; senderId: string; recipientId: string },
): void {
  const sends = calls.filter((call) => call.name === SEND_MESSAGE_TOOL_NAME);
  const delivered = sends.flatMap((call) => {
    const result = results.find((item) => item.name === call.name && item.toolCallId === call.toolCallId);
    const output = typeof result?.output === "string" ? parseToolPayload(result.output) : result?.output;
    if (!result || result.isError || !output || typeof output !== "object" || Array.isArray(output)) return [];
    const record = output as Record<string, unknown>;
    if (record.success !== true || record.error != null || typeof record.id !== "string" || !record.id) return [];
    const reply = replies.find((message) => message.id === record.id);
    return reply && reply.senderId === expected.senderId && reply.mentionIds.includes(expected.recipientId)
      && typeof call.args.content === "string" && reply.content.includes(call.args.content)
      && call.args.content.toLowerCase().includes(expected.marker.toLowerCase()) ? [reply] : [];
  });
  expect(delivered, "successful send-tool results matching a stored reply to the intended recipient").toHaveLength(1);
  expect(replies.map((reply) => reply.id), "exactly one persisted tool-delivered reply").toEqual([delivered[0]!.id]);
}
