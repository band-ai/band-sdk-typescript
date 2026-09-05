import { describe, expect, it, vi } from "vitest";

import { FernRestAdapter } from "../src/client/rest/FernRestAdapter";
import { EVENT_EMPTY_CONTENT_PLACEHOLDER } from "../src/contracts/content";
import type { Logger } from "../src/core/logger";

// Root-cause regression guard: a blank chat_result event used to reach the
// platform and 422, which escaped ACPClientAdapter's prompt-only try/catch
// and permanently killed the agent's runtime. Every send path (AgentTools,
// the ACP/A2A relays, every other direct caller) funnels through
// FernRestAdapter.createChatMessage/createChatEvent, so guarding here covers
// all of them at once.
function recordingLogger(): { logger: Logger; warnings: Array<{ message: string; context?: Record<string, unknown> }> } {
  const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];
  return {
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (message, context) => warnings.push({ message, context }),
      error: () => undefined,
    },
    warnings,
  };
}

describe("FernRestAdapter: blank content handling", () => {
  it.each([["", "empty"], ["   \n\t ", "whitespace-only"]])(
    "createChatMessage refuses %s content without calling the Fern client",
    async (content) => {
      const createAgentChatMessage = vi.fn();
      const { logger, warnings } = recordingLogger();
      const adapter = new FernRestAdapter({ agentApiMessages: { createAgentChatMessage } }, logger);

      const result = await adapter.createChatMessage("room-1", { content, mentions: [] });

      expect(result).toEqual({ ok: false, status: "blank_content", error: "content can't be blank" });
      expect(createAgentChatMessage).not.toHaveBeenCalled();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({ context: { chatId: "room-1" } });
    },
  );

  it("createChatMessage still sends content that has visible characters", async () => {
    const createAgentChatMessage = vi.fn(async () => ({ data: { ok: true, id: "msg-1" } }));
    const adapter = new FernRestAdapter({ agentApiMessages: { createAgentChatMessage } });

    const result = await adapter.createChatMessage("room-1", { content: "hello", mentions: [] });

    expect(result).toEqual({ ok: true, id: "msg-1" });
    expect(createAgentChatMessage).toHaveBeenCalledTimes(1);
  });

  it("createChatEvent substitutes a placeholder for blank content on the modern agentApiEvents namespace", async () => {
    const createAgentChatEvent = vi.fn(async () => ({ data: { ok: true, id: "evt-1" } }));
    const { logger, warnings } = recordingLogger();
    const adapter = new FernRestAdapter({ agentApiEvents: { createAgentChatEvent } }, logger);

    const result = await adapter.createChatEvent("room-1", { content: "", messageType: "tool_result" });

    expect(result).toEqual({ ok: true, id: "evt-1" });
    expect(createAgentChatEvent).toHaveBeenCalledWith(
      "room-1",
      expect.objectContaining({ event: expect.objectContaining({ content: EVENT_EMPTY_CONTENT_PLACEHOLDER }) }),
      expect.any(Object),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ context: { chatId: "room-1", messageType: "tool_result" } });
  });

  // agentApiEvents absent: falls back to createChatMessage, which must see
  // the already-substituted placeholder, not the original blank content.
  it("createChatEvent substitutes a placeholder before falling back to createChatMessage", async () => {
    const createAgentChatMessage = vi.fn(async () => ({ data: { ok: true, id: "msg-1" } }));
    const { logger, warnings } = recordingLogger();
    const adapter = new FernRestAdapter({ agentApiMessages: { createAgentChatMessage } }, logger);

    const result = await adapter.createChatEvent("room-1", { content: "  ", messageType: "thought" });

    expect(result).toEqual({ ok: true, id: "msg-1" });
    expect(createAgentChatMessage).toHaveBeenCalledWith(
      "room-1",
      expect.objectContaining({ message: expect.objectContaining({ content: EVENT_EMPTY_CONTENT_PLACEHOLDER }) }),
      expect.any(Object),
    );
    expect(warnings).toHaveLength(1);
  });

  it("createChatEvent still sends content that has visible characters", async () => {
    const createAgentChatEvent = vi.fn(async () => ({ data: { ok: true, id: "evt-1" } }));
    const adapter = new FernRestAdapter({ agentApiEvents: { createAgentChatEvent } });

    const result = await adapter.createChatEvent("room-1", { content: "sunny", messageType: "tool_result" });

    expect(result).toEqual({ ok: true, id: "evt-1" });
    expect(createAgentChatEvent).toHaveBeenCalledTimes(1);
  });
});
