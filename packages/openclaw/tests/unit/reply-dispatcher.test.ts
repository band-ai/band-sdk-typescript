import { describe, expect, it, vi } from "vitest";

import { createBandReplyDispatcher } from "../../src/reply-dispatcher.js";

function createDispatcher() {
  const link = {
    rest: {
      createChatMessage: vi.fn().mockResolvedValue({ ok: true }),
      createChatEvent: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
  const dispatcher = createBandReplyDispatcher(
    link as never,
    "default",
    "room-123",
    async () => [{ id: "user-1", name: "User" }],
  );

  return { dispatcher, link };
}

describe("Band reply dispatcher", () => {
  it("drops non-explicit final replies", async () => {
    const { dispatcher, link } = createDispatcher();

    dispatcher.sendFinalReply({ text: "I" });
    dispatcher.sendFinalReply({ text: "'ll help" });
    dispatcher.sendFinalReply({ text: " you." });
    await dispatcher.waitForIdle();

    expect(link.rest.createChatMessage).not.toHaveBeenCalled();
  });

  it("sends explicit user-facing final replies", async () => {
    const { dispatcher, link } = createDispatcher();

    dispatcher.sendFinalReply({ text: "I" });
    dispatcher.sendFinalReply({ text: "<message to user>Done.</message>" });
    await dispatcher.waitForIdle();

    expect(link.rest.createChatMessage).toHaveBeenCalledWith(
      "room-123",
      expect.objectContaining({ content: "Done." }),
    );
  });
});
