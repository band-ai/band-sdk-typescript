import type { PlatformMessage } from "../../runtime/types";

/**
 * The room and requester of this turn, for a system prompt. The Band MCP
 * server serves every room, so its tools need the `room_id` given here.
 */
export function roomContextLines(roomId: string, message: PlatformMessage): string[] {
  return [
    `Current room_id: ${roomId}`,
    `Current requester name: ${message.senderName ?? message.senderId}`,
    `Current requester id: ${message.senderId}`,
  ];
}
