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
      { id: "peer-weather" },
    ]);

    context.removeParticipant("peer-weather");
    await expect(
      context.getTools().sendMessage("hello again", ["@weather-agent"]),
    ).rejects.toThrow("Mention '@weather-agent' not found in participants");
  });
});
