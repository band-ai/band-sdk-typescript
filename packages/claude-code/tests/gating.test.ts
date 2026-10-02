import { describe, expect, it } from "vitest";

import {
  isDirectRoomWithOwner,
  isSelfMentioned,
  sanitizeMeta,
  shouldForwardMessage,
} from "../src/gating";

const SELF_ID = "3d5bd75e-1111-4c22-9e2b-8f1a2b3c4d5e";
const SELF = { id: SELF_ID, name: "Band Bot", handle: "band-bot" };
const OWNER_ID = "b4e1a2c3-2222-4c22-9e2b-8f1a2b3c4d5e";

describe("isSelfMentioned", () => {
  it("matches the id-mention token", () => {
    expect(isSelfMentioned(`hey @[[${SELF_ID}]] can you help`, SELF)).toBe(true);
  });

  it("matches the handle", () => {
    expect(isSelfMentioned("hey @band-bot can you help", SELF)).toBe(true);
  });

  it("matches the display name", () => {
    expect(isSelfMentioned("hey @Band Bot can you help", SELF)).toBe(true);
  });

  it("does not match a substring handle (e.g. @band-bot-2)", () => {
    expect(isSelfMentioned("hey @band-bot-2 can you help", SELF)).toBe(false);
  });

  it("does not treat an email-like token as a mention", () => {
    expect(isSelfMentioned("contact me at a@band-bot.example", SELF)).toBe(false);
  });

  it("does not match an unrelated message", () => {
    expect(isSelfMentioned("hey @someone-else can you help", SELF)).toBe(false);
  });

  it("returns false for empty text", () => {
    expect(isSelfMentioned("", SELF)).toBe(false);
  });
});

describe("isDirectRoomWithOwner", () => {
  it("is true for exactly the owner and this agent", () => {
    expect(isDirectRoomWithOwner([SELF.id, OWNER_ID], SELF.id, OWNER_ID)).toBe(true);
  });

  it("is false with a third participant", () => {
    expect(isDirectRoomWithOwner([SELF.id, OWNER_ID, "someone-else"], SELF.id, OWNER_ID)).toBe(false);
  });

  it("is false when the owner isn't in the room", () => {
    expect(isDirectRoomWithOwner([SELF.id, "someone-else"], SELF.id, OWNER_ID)).toBe(false);
  });
});

describe("shouldForwardMessage", () => {
  const base = {
    self: SELF,
    ownerId: OWNER_ID,
    roomParticipantIds: [SELF.id, OWNER_ID, "someone-else"],
  };

  it("forwards an owner message that mentions this agent", () => {
    expect(
      shouldForwardMessage({ ...base, text: "@band-bot help", senderId: OWNER_ID }),
    ).toBe(true);
  });

  it("drops an owner message in a group room with no mention", () => {
    expect(
      shouldForwardMessage({ ...base, text: "just chatting", senderId: OWNER_ID }),
    ).toBe(false);
  });

  it("forwards a mentioning message from any room participant", () => {
    expect(
      shouldForwardMessage({ ...base, text: "@band-bot help", senderId: "someone-else" }),
    ).toBe(true);
  });

  it("drops a non-owner message with no mention in a 1:1 room", () => {
    expect(
      shouldForwardMessage({
        ...base,
        roomParticipantIds: [SELF.id, "someone-else"],
        text: "just chatting",
        senderId: "someone-else",
      }),
    ).toBe(false);
  });

  it("forwards an owner message with no mention in a 1:1 room", () => {
    expect(
      shouldForwardMessage({
        ...base,
        roomParticipantIds: [SELF.id, OWNER_ID],
        text: "just chatting",
        senderId: OWNER_ID,
      }),
    ).toBe(true);
  });
});

describe("sanitizeMeta", () => {
  it("keeps identifier-only keys and stringifies values", () => {
    expect(sanitizeMeta({ room_id: "r1", count: 3, active: true })).toEqual({
      room_id: "r1",
      count: "3",
      active: "true",
    });
  });

  it("drops keys with hyphens or other non-identifier characters", () => {
    expect(sanitizeMeta({ "room-id": "r1", "sender.name": "x", room_id: "r1" })).toEqual({
      room_id: "r1",
    });
  });

  it("drops null and undefined values", () => {
    expect(sanitizeMeta({ room_id: "r1", sender_name: null, message_id: undefined })).toEqual({
      room_id: "r1",
    });
  });
});
