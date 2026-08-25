/**
 * Unit tests for the Band outbound send logic.
 *
 * Contract (D2/D3):
 *  - sendText resolves mentions via mentions.ts, then createChatMessage, returns { messageId }
 *  - mandatory-mention invariant: THROW when mentions resolve to empty
 *  - explicit @Name in the reply text resolves end-to-end through the adapter
 *    (this is the contract that replaces the dropped band_send_message tool)
 *  - sendMedia appends the media URL to the text and reuses the send path
 */

import { describe, it, expect, vi } from "vitest";
import { sendText, sendMedia, type OutboundDeps } from "../../src/outbound.js";

const SELF = "agent-self";

function makeDeps(
  overrides: Record<string, unknown> = {},
  lastSender: { senderId: string; senderName: string } | null = null,
): OutboundDeps {
  const rest = {
    listChatParticipants: vi.fn().mockResolvedValue([
      { id: SELF, name: "AgentBot", type: "agent" },
      { id: "u-bob", name: "Bob", type: "user" },
      { id: "u-amy", name: "Amy", type: "user" },
    ]),
    createChatMessage: vi.fn().mockResolvedValue({ id: "msg-1" }),
    ...overrides,
  };
  return {
    rest: rest as unknown as OutboundDeps["rest"],
    selfAgentId: SELF,
    getLastSender: () => lastSender,
  };
}

describe("sendText", () => {
  it("resolves an explicit @Name end-to-end and returns the messageId", async () => {
    const createChatMessage = vi.fn().mockResolvedValue({ id: "msg-42" });
    const deps = makeDeps({ createChatMessage });
    const res = await sendText(deps, { to: "room-1", text: "@Amy please review" });
    expect(res).toEqual({ messageId: "msg-42" });
    expect(createChatMessage).toHaveBeenCalledWith("room-1", {
      content: "@Amy please review",
      mentions: [{ id: "u-amy", name: "Amy" }],
    });
  });

  it("falls back to the last sender when no explicit mention", async () => {
    const createChatMessage = vi.fn().mockResolvedValue({ id: "m" });
    const deps: OutboundDeps = {
      rest: {
        listChatParticipants: vi.fn().mockResolvedValue([
          { id: SELF, name: "AgentBot", type: "agent" },
          { id: "u-bob", name: "Bob", type: "user" },
        ]),
        createChatMessage,
      } as unknown as OutboundDeps["rest"],
      selfAgentId: SELF,
      getLastSender: () => ({ senderId: "u-bob", senderName: "Bob" }),
    };
    await sendText(deps, { to: "room-1", text: "thanks!" });
    expect(createChatMessage).toHaveBeenCalledWith("room-1", {
      content: "thanks!",
      mentions: [{ id: "u-bob", name: "Bob" }],
    });
  });

  it("throws when no mention can be resolved (agent alone in room)", async () => {
    const createChatMessage = vi.fn();
    const deps: OutboundDeps = {
      rest: {
        listChatParticipants: vi.fn().mockResolvedValue([{ id: SELF, name: "AgentBot", type: "agent" }]),
        createChatMessage,
      } as unknown as OutboundDeps["rest"],
      selfAgentId: SELF,
    };
    await expect(sendText(deps, { to: "room-1", text: "hello" })).rejects.toThrow(/mention/i);
    expect(createChatMessage).not.toHaveBeenCalled();
  });

  it("throws when no room/target is given", async () => {
    const deps: OutboundDeps = {
      rest: { listChatParticipants: vi.fn(), createChatMessage: vi.fn() } as unknown as OutboundDeps["rest"],
      selfAgentId: SELF,
    };
    await expect(sendText(deps, { to: "", text: "hi" })).rejects.toThrow(/room/i);
  });
});

describe("sendMedia", () => {
  it("appends the media URL to the text and reuses the send path", async () => {
    const createChatMessage = vi.fn().mockResolvedValue({ id: "m2" });
    const deps: OutboundDeps = {
      rest: {
        listChatParticipants: vi.fn().mockResolvedValue([
          { id: SELF, name: "AgentBot", type: "agent" },
          { id: "u-bob", name: "Bob", type: "user" },
        ]),
        createChatMessage,
      } as unknown as OutboundDeps["rest"],
      selfAgentId: SELF,
      getLastSender: () => ({ senderId: "u-bob", senderName: "Bob" }),
    };
    const res = await sendMedia(deps, { to: "room-1", text: "see this", mediaUrl: "https://x/y.png" });
    expect(res).toEqual({ messageId: "m2" });
    const call = createChatMessage.mock.calls[0];
    expect(call[0]).toBe("room-1");
    expect((call[1] as { content: string }).content).toContain("https://x/y.png");
    expect((call[1] as { content: string }).content).toContain("see this");
  });
});
