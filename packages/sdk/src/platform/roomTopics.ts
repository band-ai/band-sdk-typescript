import { chatRoomTopic, roomParticipantsTopic } from "@band-ai/band-sdk-core";
import type { StreamingTransport } from "./streaming/transport";

export function roomTopics(roomId: string): { chat: string; participants: string } {
  return { chat: chatRoomTopic(roomId), participants: roomParticipantsTopic(roomId) };
}

/** The room a `chat_room:` topic belongs to, or `undefined` for any other topic. */
export function roomIdOfChatTopic(topic: string): string | undefined {
  const prefix = chatRoomTopic("");
  return (topic.startsWith(prefix) ? topic.slice(prefix.length) : "") || undefined;
}

function isRejected(
  result: PromiseSettledResult<unknown>,
): result is PromiseRejectedResult {
  return result.status === "rejected";
}

/** Leaves both of a room's topics and returns whichever leave calls rejected. */
export async function settleRoomLeaves(
  transport: StreamingTransport,
  roomId: string,
): Promise<PromiseRejectedResult[]> {
  const { chat: chatTopic, participants: participantsTopic } = roomTopics(roomId);
  const results = await Promise.allSettled([
    transport.leave(chatTopic),
    transport.leave(participantsTopic),
  ]);
  return results.filter(isRejected);
}
