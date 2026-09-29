import { agentRoomsTopic, chatRoomTopic, roomParticipantsTopic } from "@band-ai/band-sdk-core";
import { describe, expect, it } from "vitest";

import { roomIdOfChatTopic } from "../src/platform/roomTopics";

describe("roomIdOfChatTopic", () => {
  it("is the inverse of chatRoomTopic", () => {
    expect(roomIdOfChatTopic(chatRoomTopic("0d6f3a9e-room"))).toBe("0d6f3a9e-room");
  });

  it.each([roomParticipantsTopic("room-1"), agentRoomsTopic("agent-1"), chatRoomTopic(""), "", "room-1"])(
    "is undefined for %j, which names no chat room",
    (topic) => {
      expect(roomIdOfChatTopic(topic)).toBeUndefined();
    },
  );
});
