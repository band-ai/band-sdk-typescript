import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_PAGES, DEFAULT_PAGE_SIZE } from "../src/client/rest/pagination";
import type { BandLinkRestApi, PlatformChatMessage } from "../src/client/rest/types";
import { UnsupportedFeatureError, ValidationError } from "../src/core/errors";
import { getRecentMessages, listAllPeers } from "../src/rest";
import { FakeRestApi } from "./testUtils";

/** A room's context: `count` text messages, oldest first, served by cursor as Band pages it. */
class TextContextRest extends FakeRestApi {
  public constructor(private readonly count: number) {
    super();
  }

  public async getChatContext({ cursor, limit = DEFAULT_PAGE_SIZE }: { cursor?: string; limit?: number }) {
    const start = Number(cursor ?? 0);
    const end = Math.min(this.count, start + limit);
    const hasMore = end < this.count;
    return {
      data: Array.from({ length: end - start }, (_, index): PlatformChatMessage => ({
        id: `m${start + index + 1}`,
        message_type: "text",
        content: `message ${start + index + 1}`,
        sender_id: "peer-1",
        sender_type: "User",
        inserted_at: "2026-10-08T00:00:00Z",
      })),
      metadata: { has_more: hasMore, ...(hasMore ? { next_cursor: String(end) } : {}) },
    };
  }
}

/** The most context one walk reads: every page the cap allows, full. */
const CAPPED_ROOM = DEFAULT_MAX_PAGES * DEFAULT_PAGE_SIZE;

describe("REST helpers on link.rest", () => {
  it("lists peers from link.rest whose listPeers reads its own state", async () => {
    class PeersRest extends FakeRestApi {
      private readonly peer = { id: "peer-1", name: "Ada", type: "User" as const };

      public override async listPeers({ page }: { page: number; pageSize: number }) {
        return { data: page === 1 ? [this.peer] : [] };
      }
    }
    const rest: BandLinkRestApi = new PeersRest();

    expect(await listAllPeers(rest)).toEqual([{ id: "peer-1", name: "Ada", type: "User" }]);
  });

  it("returns the newest text messages from link.rest, skipping other types", async () => {
    class ContextRest extends FakeRestApi {
      private readonly messages: PlatformChatMessage[] = [
        { id: "old", message_type: "text", content: "old" },
        { id: "event", message_type: "thought", content: "thinking" },
        { id: "new", message_type: "text", content: "new" },
      ].map((message) => ({ ...message, sender_id: "peer-1", sender_type: "User", inserted_at: "2026-10-08T00:00:00Z" }));

      public async getChatContext() {
        return { data: this.messages };
      }
    }
    const rest: BandLinkRestApi = new ContextRest();

    expect((await getRecentMessages(rest, "room-1", 1)).map(({ id }) => id)).toEqual(["new"]);
  });

  it("reports unsupported peer listing", async () => {
    const rest: BandLinkRestApi = new FakeRestApi();
    rest.listPeers = undefined;

    await expect(listAllPeers(rest)).rejects.toBeInstanceOf(UnsupportedFeatureError);
  });

  it("reports unsupported context lookup", async () => {
    const rest: BandLinkRestApi = new FakeRestApi();

    await expect(getRecentMessages(rest, "room-1")).rejects.toBeInstanceOf(UnsupportedFeatureError);
  });

  it("returns the newest 20 messages by default, oldest first", async () => {
    const recent = await getRecentMessages(new TextContextRest(25), "room-1");

    expect(recent.map(({ id }) => id)).toEqual(Array.from({ length: 20 }, (_, index) => `m${index + 6}`));
  });

  it("returns the newest messages from a room that fills the page cap exactly", async () => {
    const [newest] = await getRecentMessages(new TextContextRest(CAPPED_ROOM), "room-1", 1);

    expect(newest?.id).toBe(`m${CAPPED_ROOM}`);
  });

  it("refuses rather than return older messages from a room past the page cap", async () => {
    await expect(getRecentMessages(new TextContextRest(CAPPED_ROOM + 1), "room-1", 1)).rejects.toBeInstanceOf(ValidationError);
  });

  it.each([0, 101, 1.5])("refuses a limit of %s", async (limit) => {
    await expect(getRecentMessages(new TextContextRest(1), "room-1", limit)).rejects.toBeInstanceOf(ValidationError);
  });
});
