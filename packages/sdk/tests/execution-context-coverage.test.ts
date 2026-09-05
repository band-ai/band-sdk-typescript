import { describe, expect, it, vi } from "vitest";

import { EVENT_SEND_FAILED_STATUS } from "../src/contracts/content";
import { UnsupportedFeatureError } from "../src/core/errors";
import type { Logger } from "../src/core/logger";
import { ExecutionContext } from "../src/runtime/ExecutionContext";
import type { RestApi } from "../src/client/rest/types";
import { FakeRestApi, makeMessage } from "./testUtils";

function makeContext(restOverrides?: Partial<RestApi>, options?: {
  maxContextMessages?: number;
  enableContextCache?: boolean;
  contextCacheTtlSeconds?: number;
  enableContextHydration?: boolean;
  logger?: Logger;
}) {
  return new ExecutionContext({
    roomId: "room-1",
    link: {
      rest: new FakeRestApi(restOverrides),
      capabilities: {},
    },
    maxContextMessages: options?.maxContextMessages ?? 3,
    enableContextCache: options?.enableContextCache,
    contextCacheTtlSeconds: options?.contextCacheTtlSeconds,
    enableContextHydration: options?.enableContextHydration,
    logger: options?.logger,
  });
}

describe("ExecutionContext coverage", () => {
  it("hydrates paginated context, caches it, and honors force refresh", async () => {
    const listParticipants = vi.fn(async () => [
      { id: "u1", name: "Jane", type: "User", handle: "@jane" },
    ]);
    const getChatContext = vi.fn(
      async (request: { chatId: string; page?: number; pageSize?: number }) => {
        const page = request.page ?? 1;
      if (page === 1) {
        return {
          data: [{
            id: "m1",
            content: "one",
            sender_id: "u1",
            sender_type: "User",
            inserted_at: "2026-03-01T00:00:00.000Z",
            message_type: "text",
          }],
          metadata: { page: 1, pageSize: 1, totalPages: 2 },
        };
      }

      return {
        data: [{
          id: "m2",
          content: "two",
          sender_id: "a1",
          sender_type: "Agent",
          inserted_at: "2026-03-01T00:01:00.000Z",
          message_type: "text",
        }],
        metadata: { page: 2, pageSize: 1, totalPages: 2 },
      };
      },
    );
    const ctx = new ExecutionContext({
      roomId: "room-1",
      link: {
        rest: {
          ...(new FakeRestApi() as RestApi),
          listChatParticipants: listParticipants,
          getChatContext,
        },
        capabilities: {},
      },
      maxContextMessages: 3,
    });

    const first = await ctx.hydrateContext();
    const cached = await ctx.hydrateContext();
    const refreshed = await ctx.hydrateContext(true);

    expect(first.messages.map((entry) => entry.id)).toEqual(["m1", "m2"]);
    expect(first.participants).toEqual([{ id: "u1", name: "Jane", type: "User", handle: "@jane" }]);
    expect(cached).toBe(first);
    expect(refreshed).not.toBe(first);
    expect(listParticipants).toHaveBeenCalledTimes(2);
    expect(getChatContext).toHaveBeenCalledTimes(4);
  });

  it("falls back to local context when hydrated context is unsupported", async () => {
    const ctx = makeContext({
      getChatContext: async () => {
        throw new UnsupportedFeatureError("not available");
      },
    });
    ctx.recordMessage(makeMessage("hello"));

    const hydrated = await ctx.hydrateContext();
    const history = await ctx.getHydratedHistory("msg-1");

    expect(hydrated.messages).toHaveLength(1);
    expect(hydrated.messages[0]?.content).toBe("hello");
    expect(history).toEqual([]);
  });

  it("updates the cached context when new messages and participants arrive and trims history", async () => {
    const ctx = makeContext({
      listChatParticipants: async () => [],
      getChatContext: async () => ({
        data: [{
          id: "m0",
          content: "seed",
          sender_id: "u0",
          sender_type: "User",
          inserted_at: "2026-03-01T00:00:00.000Z",
          message_type: "text",
        }],
        metadata: { page: 1, pageSize: 1, totalPages: 1 },
      }),
    }, { maxContextMessages: 2 });

    await ctx.hydrateContext();
    ctx.addParticipant({ id: "a1", name: "Bridge", type: "Agent", handle: "@bridge" });
    ctx.recordMessage({ ...makeMessage("later"), id: "m1" });
    ctx.recordMessage({ ...makeMessage("latest"), id: "m2" });

    const hydrated = await ctx.hydrateContext();
    expect(hydrated.participants).toEqual([
      { id: "a1", name: "Bridge", type: "Agent", handle: "@bridge" },
    ]);
    expect(hydrated.messages.map((entry) => entry.id)).toEqual(["m1", "m2"]);
  });

  it("bypasses hydration entirely when disabled", async () => {
    const getChatContext = vi.fn(async () => ({
      data: [],
    }));
    const ctx = makeContext({
      getChatContext,
    }, { enableContextHydration: false });
    ctx.recordMessage(makeMessage("local-only"));

    const hydrated = await ctx.hydrateContext();
    expect(hydrated.messages[0]?.content).toBe("local-only");
    expect(getChatContext).not.toHaveBeenCalled();
  });

  it("returns an isolated participants snapshot on every hydration", async () => {
    const ctx = makeContext({}, { enableContextHydration: false });
    ctx.addParticipant({ id: "u1", name: "Jane", type: "User", handle: "@jane" });

    const first = await ctx.hydrateContext();
    first.participants.push({ id: "intruder", name: "Ghost", type: "User", handle: null });
    (first.participants[0] as { name: string }).name = "Mutated";

    const second = await ctx.hydrateContext();
    expect(second.participants).toEqual([{ id: "u1", name: "Jane", type: "User", handle: "@jane" }]);
  });

  it("threads a caller-supplied logger into the AgentTools it builds, so a sendEvent failure is actually logged", async () => {
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const ctx = makeContext(
      { createChatEvent: async () => { throw new Error("network error"); } },
      { logger },
    );

    await expect(ctx.getTools().sendEvent("thinking", "thought")).resolves.toEqual({
      ok: false,
      status: EVENT_SEND_FAILED_STATUS,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      "chat event send failed",
      expect.objectContaining({ roomId: "room-1", messageType: "thought" }),
    );
  });
});
