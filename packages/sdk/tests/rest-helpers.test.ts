import { describe, expect, it } from "vitest";

import type { BandLinkRestApi, PlatformChatMessage } from "../src/client/rest/types";
import { UnsupportedFeatureError } from "../src/core/errors";
import { getRecentMessages, listAllPeers } from "../src/rest";
import { FakeRestApi } from "./testUtils";

describe("REST helpers on link.rest", () => {
  it("accepts BandLinkRestApi and preserves the receiver across peer pages", async () => {
    class PeersRest extends FakeRestApi {
      private readonly peer = { id: "peer-1", name: "Ada", type: "User" as const };

      public override async listPeers({ page }: { page: number; pageSize: number }) {
        return { data: page === 1 ? [this.peer] : [] };
      }
    }
    const rest: BandLinkRestApi = new PeersRest();

    expect(await listAllPeers(rest)).toEqual([{ id: "peer-1", name: "Ada", type: "User" }]);
  });

  it("accepts BandLinkRestApi and returns only the newest text context", async () => {
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
});
