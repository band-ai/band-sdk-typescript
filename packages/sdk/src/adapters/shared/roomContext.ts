import type { PlatformMessage } from "../../runtime/types";

/**
 * The room and requester of this turn, for a system prompt. A multi-room Band
 * MCP server (opencode's) needs the `room_id` given here on every tool call.
 */
export function roomContextLines(roomId: string, message: PlatformMessage): string[] {
  return [
    `Current room_id: ${roomId}`,
    `Current requester name: ${message.senderName ?? message.senderId}`,
    `Current requester id: ${message.senderId}`,
  ];
}
