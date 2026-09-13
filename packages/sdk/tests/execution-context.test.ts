import { describe, expect, it } from "vitest";

import { RestFacade } from "../src/client/rest/RestFacade";
import { ExecutionContext } from "../src/runtime/ExecutionContext";
import { FakeRestApi } from "./testUtils";

describe("ExecutionContext", () => {
  it("keeps mention resolution in sync after participant updates", async () => {
    const capturedMentions: Array<unknown> = [];
    const restApi = new FakeRestApi({
      createChatMessage: async (_chatId, message) => {
        capturedMentions.push(message.mentions ?? []);
        return { ok: true };
      },
    });

    const context = new ExecutionContext({
      roomId: "room-1",
      link: {
        rest: new RestFacade({ api: restApi }),
      },
      maxContextMessages: 20,
    });

    context.addParticipant({
      id: "peer-weather",
      name: "Weather Agent",
      type: "Agent",
      handle: "weather-agent",
    });

    await context.getTools().sendMessage("hello", ["@weather-agent"]);
    expect(capturedMentions[0]).toEqual([
      { id: "peer-weather", handle: "weather-agent" },
    ]);

    context.removeParticipant("peer-weather");
    await expect(
      context.getTools().sendMessage("hello again", ["@weather-agent"]),
    ).rejects.toThrow("Mention '@weather-agent' not found in participants");
  });

  it("merges a sparse addParticipant update without clobbering existing fields or re-announcing a join", () => {
    const context = new ExecutionContext({
      roomId: "room-1",
      link: { rest: new RestFacade({ api: new FakeRestApi() }) },
      maxContextMessages: 20,
    });

    context.addParticipant({ id: "p1", name: "Weather Agent", type: "Agent", handle: "old-handle" });
    const firstMessage = context.consumeParticipantsMessage();
    expect(firstMessage).toContain("Weather Agent joined the room.");
    expect(firstMessage).toContain("old-handle");

    context.addParticipant({ id: "p1", handle: "new-handle" });
    const secondMessage = context.consumeParticipantsMessage();

    expect(secondMessage).not.toBeNull();
    expect(secondMessage).not.toContain("joined the room");
    expect(secondMessage).toContain("new-handle");
    expect(secondMessage).toContain("Weather Agent");
  });

  it("replaces roster membership via setParticipants", () => {
    const context = new ExecutionContext({
      roomId: "room-1",
      link: { rest: new RestFacade({ api: new FakeRestApi() }) },
      maxContextMessages: 20,
    });

    context.addParticipant({ id: "stale", name: "Stale", type: "User", handle: "stale" });
    context.consumeParticipantsMessage();

    context.setParticipants([{ id: "fresh", name: "Fresh", type: "User", handle: "fresh" }]);
    const message = context.consumeParticipantsMessage();

    expect(message).toContain("Fresh");
    expect(message).not.toContain("Stale");
  });

  it("keeps a tool-driven participant change visible to consumeParticipantsMessage and safe from an unrelated WS-driven change", async () => {
    const restApi = new FakeRestApi({
      listChatParticipants: async () => [],
      listPeers: async () => ({
        data: [{ id: "peer-weather", name: "Weather Agent", type: "Agent", handle: "weather-agent" }],
      }),
      addChatParticipant: async () => ({ ok: true }),
    });
    const context = new ExecutionContext({
      roomId: "room-1",
      link: { rest: new RestFacade({ api: restApi }) },
      maxContextMessages: 20,
    });

    await context.getTools().addParticipant("Weather Agent");
    const afterToolAdd = context.consumeParticipantsMessage();
    expect(afterToolAdd).toContain("Weather Agent");

    context.addParticipant({ id: "peer-other", name: "Other Agent", type: "Agent", handle: "other-agent" });
    const afterWsAdd = context.consumeParticipantsMessage();
    expect(afterWsAdd).toContain("Weather Agent");
    expect(afterWsAdd).toContain("Other Agent");
  });
});
