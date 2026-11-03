import { expect } from "vitest";

import { SEND_MESSAGE_TOOL_NAME } from "../../../src/contracts/toolSchemas";
import { parseToolPayload } from "../../../src/converters/shared";
import { resolveMentions } from "../../../src/runtime/formatters";
import type { CapturedMessage, ToolCallEvent, ToolResultEvent } from "./observeMessages";

/** The message a send result reports it posted, when it reports success. */
function postedMessageId(result: ToolResultEvent): string | null {
  const output = typeof result.output === "string" ? parseToolPayload(result.output) : result.output;
  if (result.isError || !output || typeof output !== "object" || Array.isArray(output)) return null;
  const record = output as Record<string, unknown>;
  return record.success === true && record.error == null && typeof record.id === "string" && record.id ? record.id : null;
}

/**
 * Proves the agent's replies came through the send tool and nothing else: a
 * send delivered the marker to the recipient, every reply in the room was
 * posted by a successful send (no closing text relayed after it), and no send
 * ran more than once. A model may still send twice on its own; that is two
 * calls, not a re-run. Call ids are matched by count, not assumed unique:
 * adapters may reuse a positional id across rounds.
 */
export function assertToolReply(
  calls: readonly ToolCallEvent[],
  results: readonly ToolResultEvent[],
  replies: readonly CapturedMessage[],
  expected: { marker: string; senderId: string; recipientId: string },
): void {
  const sends = calls.filter((call) => call.name === SEND_MESSAGE_TOOL_NAME);
  const sendResults = results.filter((result) => result.name === SEND_MESSAGE_TOOL_NAME);
  const posted = sendResults
    .flatMap((result) => {
      const messageId = postedMessageId(result);
      return messageId ? [{ toolCallId: result.toolCallId, messageId }] : [];
    });

  const markerReplies = posted.filter(({ toolCallId, messageId }) => {
    const reply = replies.find((message) => message.id === messageId);
    return reply && reply.senderId === expected.senderId && reply.mentionIds.includes(expected.recipientId)
      && sends.some((call) => call.toolCallId === toolCallId
        && typeof call.args.content === "string"
        && resolveMentions(reply.content, reply.metadata).includes(resolveMentions(call.args.content, reply.metadata))
        && call.args.content.toLowerCase().includes(expected.marker.toLowerCase()));
  });
  expect(markerReplies.length, "successful send-tool results matching a stored reply to the intended recipient").toBeGreaterThan(0);

  const postedIds = new Set(posted.map(({ messageId }) => messageId));
  expect(replies.filter((reply) => !postedIds.has(reply.id)).map((reply) => reply.content), "replies no successful send-tool result posted")
    .toEqual([]);

  // Every run reports a result, failed or not, so a re-run shows as more results than calls.
  for (const toolCallId of new Set(sendResults.map((result) => result.toolCallId))) {
    const ran = sendResults.filter((result) => result.toolCallId === toolCallId).length;
    const called = sends.filter((call) => call.toolCallId === toolCallId).length;
    expect(ran, `send-tool results for ${toolCallId}, at most one per call`).toBeLessThanOrEqual(called);
  }
}
