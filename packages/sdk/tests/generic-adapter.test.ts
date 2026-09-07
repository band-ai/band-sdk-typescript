import { describe, expect, it } from "vitest";

import { GenericAdapter } from "../src/adapters/GenericAdapter";
import { HistoryProvider } from "../src/runtime/types";
import { FakeTools, findFailureEvent, makeMessage, expectTurnFailed } from "./testUtils";
import { FAILURE_EVENT_TYPE } from "../src/contracts/protocols";

describe("GenericAdapter", () => {
  it("reports and fails the turn when the handler throws, instead of escaping unguarded", async () => {
    const adapter = new GenericAdapter(async () => {
      throw new Error("handler bug");
    });
    await adapter.onStarted("Agent", "An agent");

    const tools = new FakeTools();
    await expectTurnFailed(
      adapter.onMessage(
        makeMessage("hello"),
        tools,
        new HistoryProvider([]),
        null,
        null,
        { isSessionBootstrap: false, roomId: "room-1" },
      ),
    );

    const failureEvent = findFailureEvent(tools);
    expect(failureEvent?.metadata?.failure).toMatchObject({
      provider: "generic",
      message: "handler bug",
    });
    expect(tools.events.filter((event) => event.messageType === FAILURE_EVENT_TYPE)).toHaveLength(1);
  });

  it("does not run the handler's onMessage body twice for successful turns", async () => {
    const calls: string[] = [];
    const adapter = new GenericAdapter(async ({ message }) => {
      calls.push(message.content);
    });
    await adapter.onStarted("Agent", "An agent");

    const tools = new FakeTools();
    await adapter.onMessage(
      makeMessage("hello"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-1" },
    );

    expect(calls).toEqual(["hello"]);
    expect(tools.events).toEqual([]);
  });
});
