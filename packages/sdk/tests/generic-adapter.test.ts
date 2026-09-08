import { describe, expect, it } from "vitest";

import { GenericAdapter } from "../src/adapters/GenericAdapter";
import { HistoryProvider } from "../src/runtime/types";
import { FakeTools, findFailureEvent, makeMessage, expectTurnFailed } from "./testUtils";
import { describeDeliveryContract } from "./deliveryContract";
import { FAILURE_EVENT_TYPE, type AdapterToolsProtocol } from "../src/contracts/protocols";

describe("GenericAdapter", () => {
  describeDeliveryContract([{
    path: "the handler's own sendMessage reply",
    turn: async (tools) => {
      const adapter = new GenericAdapter(async ({ tools: handlerTools }) => {
        await handlerTools.sendMessage("the answer");
      });
      await adapter.onStarted("Agent", "An agent");
      await adapter.onMessage(
        makeMessage("hello"),
        tools,
        new HistoryProvider([]),
        null,
        null,
        { isSessionBootstrap: false, roomId: "room-1" },
      );
    },
  }]);

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

  it("works against a frozen tools object matching AgentTools.buildAdapterTools()'s production shape", async () => {
    // AgentTools.buildAdapterTools() hands adapters a plain object whose
    // methods are OWN, `Object.freeze`d data properties — unlike a class
    // instance (e.g. FakeTools), whose methods live on the prototype and are
    // untouched by freezing an instance. A naive `Proxy`-based facade whose
    // `get` trap returns a replacement for a frozen *own* data property
    // violates the Proxy invariant and throws a TypeError instead of ever
    // reaching the handler — this shape is what actually exercises that.
    const messages: string[] = [];
    const events: Array<{ content: string; messageType: string }> = [];
    const tools = Object.freeze({
      sendMessage: async (content: string) => {
        messages.push(content);
        return { ok: true };
      },
      sendEvent: async (content: string, messageType: string) => {
        events.push({ content, messageType });
        return { ok: true };
      },
    }) as unknown as AdapterToolsProtocol;

    let observedResult: unknown;
    const adapter = new GenericAdapter(async ({ tools: handlerTools }) => {
      observedResult = await handlerTools.sendMessage("the answer");
      // Exercises a forwarded (non-overridden) method to confirm the facade
      // still delegates everything else through to the real, frozen tools.
      await handlerTools.sendEvent("note", "task");
    });
    await adapter.onStarted("Agent", "An agent");

    await adapter.onMessage(
      makeMessage("hello"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-1" },
    );

    expect(observedResult).toEqual({ ok: true });
    expect(messages).toEqual(["the answer"]);
    expect(events).toEqual([{ content: "note", messageType: "task" }]);
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
