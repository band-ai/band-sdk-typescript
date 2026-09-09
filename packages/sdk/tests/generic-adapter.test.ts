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

  it("works against a class-based tools implementation whose methods use real private fields", async () => {
    // A bare `Object.create(tools)` delegate reads a forwarded method
    // correctly, but *calling* it runs with `this` bound to the facade, not
    // `tools` — a class whose methods use genuine `#private` fields throws
    // on any object other than a real instance of that class, even for an
    // unmodified, non-overridden method like sendEvent.
    class FakeAgentTools {
      #calls = 0;
      public readonly messages: string[] = [];

      public async sendMessage(content: string): Promise<{ ok: true }> {
        this.messages.push(content);
        return { ok: true };
      }

      public async sendEvent(): Promise<{ ok: true; calls: number }> {
        this.#calls += 1;
        return { ok: true, calls: this.#calls };
      }
    }

    const tools = new FakeAgentTools() as unknown as AdapterToolsProtocol;

    let observedResult: unknown;
    let observedEventResult: unknown;
    const adapter = new GenericAdapter(async ({ tools: handlerTools }) => {
      observedResult = await handlerTools.sendMessage("the answer");
      observedEventResult = await handlerTools.sendEvent("note", "task");
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
    expect(observedEventResult).toEqual({ ok: true, calls: 1 });
    expect((tools as unknown as FakeAgentTools).messages).toEqual(["the answer"]);
  });

  it("works when a forwarded method lives two prototype levels up (inheritance), without throwing on a real private field", async () => {
    // Object.getPrototypeOf(tools) only reaches DerivedTools.prototype;
    // sendEvent is inherited from BaseAgentTools.prototype, one level
    // further up. A facade that only rebinds methods it can enumerate at
    // that one level would miss sendEvent entirely, so calling it falls
    // through the facade's own prototype chain and runs with `this` bound
    // to the facade — a real #private field then throws even though
    // sendEvent is a completely unmodified, inherited method.
    class BaseAgentTools {
      #eventCount = 0;
      public readonly messages: string[] = [];

      public async sendMessage(content: string): Promise<{ ok: true }> {
        this.messages.push(content);
        return { ok: true };
      }

      public async sendEvent(): Promise<{ ok: true; count: number }> {
        this.#eventCount += 1;
        return { ok: true, count: this.#eventCount };
      }
    }
    class DerivedTools extends BaseAgentTools {}

    const tools = new DerivedTools() as unknown as AdapterToolsProtocol;
    const observed: unknown[] = [];
    const adapter = new GenericAdapter(async ({ tools: handlerTools }) => {
      observed.push(await handlerTools.sendEvent("note", "task"));
    });
    await adapter.onStarted("Agent", "An agent");

    for (let i = 0; i < 2; i += 1) {
      await adapter.onMessage(
        makeMessage("hello"),
        tools,
        new HistoryProvider([]),
        null,
        null,
        { isSessionBootstrap: false, roomId: "room-1" },
      );
    }

    expect(observed).toEqual([
      { ok: true, count: 1 },
      { ok: true, count: 2 },
    ]);
  });

  it("mutates the real tools instance's state across turns instead of shadowing it on a disposable per-turn facade", async () => {
    // Same inheritance-depth gap as above, but with a plain (non-#) field:
    // instead of throwing, a facade that misses this method and calls it
    // with `this` bound to a fresh facade each turn would let `this.count =
    // ...` create a shadow own-property on the facade rather than mutating
    // the real instance — every turn would see the field reset to 0 and
    // independently become 1, instead of the count genuinely advancing.
    class BaseAgentTools {
      public count = 0;

      public async sendMessage(): Promise<{ ok: true }> {
        return { ok: true };
      }

      public async sendEvent(): Promise<{ ok: true; count: number }> {
        this.count += 1;
        return { ok: true, count: this.count };
      }
    }
    class DerivedTools extends BaseAgentTools {}

    const tools = new DerivedTools() as unknown as AdapterToolsProtocol;
    const observed: unknown[] = [];
    const adapter = new GenericAdapter(async ({ tools: handlerTools }) => {
      observed.push(await handlerTools.sendEvent("note", "task"));
    });
    await adapter.onStarted("Agent", "An agent");

    for (let i = 0; i < 2; i += 1) {
      await adapter.onMessage(
        makeMessage("hello"),
        tools,
        new HistoryProvider([]),
        null,
        null,
        { isSessionBootstrap: false, roomId: "room-1" },
      );
    }

    expect(observed).toEqual([
      { ok: true, count: 1 },
      { ok: true, count: 2 },
    ]);
    expect((tools as unknown as DerivedTools).count).toBe(2);
  });

  it("forwards an inherited accessor with the real tools instance as receiver, not the facade", async () => {
    // Accessors are never functions themselves, so a facade that only
    // rebinds properties whose *current value* happens to be a function
    // (peeked once, at construction time) never installs a forwarding
    // override for a getter at all — access falls through to the facade's
    // own prototype chain and re-invokes the getter with `this` bound to
    // the facade instead of the real instance.
    class BaseAgentTools {
      #label = "base-label";

      public get label(): string {
        return this.#label;
      }

      public async sendMessage(): Promise<{ ok: true }> {
        return { ok: true };
      }

      public async sendEvent(): Promise<{ ok: true }> {
        return { ok: true };
      }
    }
    class DerivedTools extends BaseAgentTools {}

    const tools = new DerivedTools() as unknown as AdapterToolsProtocol & { label: string };
    let observedLabel: unknown;
    const adapter = new GenericAdapter(async ({ tools: handlerTools }) => {
      observedLabel = (handlerTools as unknown as { label: string }).label;
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

    expect(observedLabel).toBe("base-label");
  });

  it("enumerates the real tools' own keys through Object.keys/spread, not the proxy's empty target", async () => {
    // A Proxy with only `has`/`get` traps reports zero own keys (its target is
    // an empty object), so handler code that copies or decorates its tools —
    // `{ ...tools }`, `Object.assign({}, tools)`, `Object.keys(tools)` — would
    // otherwise silently lose every method.
    const tools = Object.freeze({
      sendMessage: async () => ({ ok: true }) as const,
      sendEvent: async () => ({ ok: true }) as const,
    }) as unknown as AdapterToolsProtocol;

    let observedKeys: string[] = [];
    let observedSpreadKeys: string[] = [];
    const adapter = new GenericAdapter(async ({ tools: handlerTools }) => {
      observedKeys = Object.keys(handlerTools);
      observedSpreadKeys = Object.keys({ ...handlerTools });
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

    expect(observedKeys.sort()).toEqual(["sendEvent", "sendMessage"]);
    expect(observedSpreadKeys.sort()).toEqual(["sendEvent", "sendMessage"]);
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
