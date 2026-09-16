import { describe, expect, it, vi } from "vitest";

import { FernRestAdapter } from "../src/client/rest/FernRestAdapter";

/**
 * listMessages and getChatContext each prefer a modern namespace
 * (chatMessages / chatContext) and fall back to an agent-scoped one
 * (agentApiMessages / agentApiContext) when the modern one is absent — a
 * broken fallback chain would silently drop support for older clients.
 */
describe("FernRestAdapter: agent-namespace fallbacks for message listing", () => {
  it("listMessages falls back to agentApiMessages.listAgentMessages", async () => {
    const listAgentMessages = vi.fn(async () => ({
      data: [
        {
          id: "m1",
          content: "hi",
          sender_id: "u1",
          sender_type: "User",
          message_type: "text",
          inserted_at: "2026-03-10T00:00:00.000Z",
        },
      ],
      metadata: { page: 1, page_size: 10, total_count: 1, total_pages: 1 },
    }));
    const adapter = new FernRestAdapter({
      agentApiMessages: { listAgentMessages },
    });

    const result = await adapter.listMessages({ chatId: "room-1", page: 1, pageSize: 10 });

    expect(result.data).toEqual([
      expect.objectContaining({ id: "m1", content: "hi" }),
    ]);
    expect(listAgentMessages).toHaveBeenCalledWith(
      "room-1",
      { page: 1, page_size: 10, status: undefined },
      expect.any(Object),
    );
  });

  it("getChatContext falls back to agentApiContext.getAgentChatContext", async () => {
    const getAgentChatContext = vi.fn(async () => ({
      data: [
        {
          id: "ctx-1",
          content: "context",
          sender_id: "u1",
          sender_type: "User",
          message_type: "text",
          inserted_at: "2026-03-10T00:00:00.000Z",
        },
      ],
      metadata: { page: 1, page_size: 5, total_count: 1, total_pages: 1 },
    }));
    const adapter = new FernRestAdapter({
      agentApiContext: { getAgentChatContext },
    });

    const result = await adapter.getChatContext({ chatId: "room-1", page: 1, pageSize: 5 });

    expect(result.data).toEqual([
      expect.objectContaining({ id: "ctx-1", content: "context" }),
    ]);
    expect(getAgentChatContext).toHaveBeenCalledWith(
      "room-1",
      { page: 1, page_size: 5 },
      expect.any(Object),
    );
  });
});
