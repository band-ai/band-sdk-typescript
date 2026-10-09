import { describe, expect, it } from "vitest";

import { MessageMemory, REPLY_MEMORY_SIZE } from "../../src/messages";

describe("MessageMemory", () => {
  it(`forgets only the oldest message once it holds more than ${REPLY_MEMORY_SIZE}`, () => {
    const memory = new MessageMemory();
    for (let n = 0; n <= REPLY_MEMORY_SIZE; n += 1) {
      memory.remember(`msg-${n}`, { roomId: `room-${n % 3}`, senderId: `user-${n}` });
    }

    expect(memory.recall("msg-0")).toBeUndefined();
    expect(memory.recall("msg-1")).toEqual({ roomId: "room-1", senderId: "user-1" });
    expect(memory.recall(`msg-${REPLY_MEMORY_SIZE}`)).toEqual({ roomId: `room-${REPLY_MEMORY_SIZE % 3}`, senderId: `user-${REPLY_MEMORY_SIZE}` });
  });
});
