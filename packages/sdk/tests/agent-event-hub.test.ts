import { describe, expect, it } from "vitest";

import type { AgentEvent } from "../src/contracts/events";
import { createDeferred } from "../src/core/deferred";
import { AgentEventHub } from "../src/runtime/agentEvents";
import { makeLoggerSpy } from "./testUtils";

const room = (type: "room.joined" | "room.stopped", roomId: string): AgentEvent => ({ type, roomId });

const MARKER: AgentEvent = { type: "link.disconnected", reason: "closed" };

/** Resolves once `hub` has delivered everything emitted before it, by emitting a marker last. */
function delivered(hub: AgentEventHub): Promise<void> {
  const done = createDeferred();
  const stop = hub.observe((event) => {
    if (event === MARKER) {
      stop();
      done.resolve();
    }
  });
  hub.emit(MARKER);
  return done.promise;
}

describe("AgentEventHub delivery", () => {
  it("delivers after the emitting code returns, in emit order, including events a listener emits", async () => {
    const hub = new AgentEventHub(makeLoggerSpy());
    const seen: string[] = [];
    hub.observe((event) => {
      seen.push(event.type === "room.joined" || event.type === "room.stopped" ? `${event.type}:${event.roomId}` : event.type);
      if (event.type === "room.joined" && event.roomId === "a") {
        hub.emit(room("room.stopped", "a"));
      }
    });

    hub.emit(room("room.joined", "a"));
    hub.emit(room("room.joined", "b"));
    expect(seen).toEqual([]);

    await delivered(hub);
    expect(seen).toEqual(["room.joined:a", "room.joined:b", "link.disconnected", "room.stopped:a"]);
  });

  it("skips a listener removed before delivery and never shows earlier events to a later one", async () => {
    const hub = new AgentEventHub(makeLoggerSpy());
    const removed: AgentEvent[] = [];
    const late: AgentEvent[] = [];
    const stop = hub.observe((event) => { removed.push(event); });

    hub.emit(room("room.joined", "a"));
    stop();
    hub.observe((event) => { late.push(event); });
    await delivered(hub);

    expect(removed).toEqual([]);
    expect(late).toEqual([MARKER]);
  });

  it("skips a listener another listener removes while the same event is being delivered", async () => {
    const hub = new AgentEventHub(makeLoggerSpy());
    const removed: AgentEvent[] = [];
    let stopRemoved = () => {};
    hub.observe((event) => {
      if (event.type === "room.joined") stopRemoved();
    });
    stopRemoved = hub.observe((event) => { removed.push(event); });

    hub.emit(room("room.joined", "a"));
    await delivered(hub);

    expect(removed).toEqual([]);
  });

  it("never shows a listener added again the events emitted before it was added again", async () => {
    const hub = new AgentEventHub(makeLoggerSpy());
    const seen: AgentEvent[] = [];
    const listener = (event: AgentEvent) => { seen.push(event); };
    const stop = hub.observe(listener);

    hub.emit(room("room.joined", "before"));
    stop();
    hub.observe(listener);
    hub.emit(room("room.joined", "after"));
    await delivered(hub);

    expect(seen).toEqual([room("room.joined", "after"), MARKER]);
  });

  it("logs a throwing or rejecting listener and still delivers to the others", async () => {
    const logger = makeLoggerSpy();
    const allLogged = createDeferred();
    const forEvent = () => logger.warn.mock.calls.filter(([, context]) => context?.eventType === "room.joined");
    logger.warn.mockImplementation(() => {
      if (forEvent().length === 2) allLogged.resolve();
    });
    const hub = new AgentEventHub(logger);
    const seen: AgentEvent[] = [];
    hub.observe(() => { throw new Error("boom"); });
    hub.observe(async () => { throw new Error("async boom"); });
    hub.observe((event) => { seen.push(event); });

    hub.emit(room("room.joined", "a"));
    await delivered(hub);

    expect(seen).toEqual([room("room.joined", "a"), MARKER]);
    await allLogged.promise;
    const failure = (message: string) => ["agent_events.listener_failed", { eventType: "room.joined", error: new Error(message) }];
    expect(forEvent()).toHaveLength(2);
    expect(forEvent()).toEqual(expect.arrayContaining([failure("boom"), failure("async boom")]));
  });
});
