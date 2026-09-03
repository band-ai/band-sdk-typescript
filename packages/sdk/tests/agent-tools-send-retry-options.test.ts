import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FernRestAdapter } from "../src/client/rest/FernRestAdapter";
import { AgentTools } from "../src/runtime/tools/AgentTools";
import { ContactCallbackTools } from "../src/runtime/tools/ContactCallbackTools";
import { SUSTAINED_429 } from "./support/fakeFetchServer";
import { buildFakeRestAdapter } from "./support/fakeRestAdapter";
import { settleThroughRetries } from "./support/settleThroughRetries";

/**
 * `mergeOptions` spreads a caller-supplied `options` last, so it can win
 * over an operation's own retry cap — deliberately, for a genuine per-call
 * override. If a caller instead forwards the SDK's generic
 * `DEFAULT_REQUEST_OPTIONS` out of habit (rather than omitting the argument
 * when it has no override), that forwarded default silently masks the
 * message-send operation's tighter retry cap. These tests wire the real
 * tool-layer send paths to a fake `fetch` and count wire attempts directly,
 * so a reintroduced forwarded default fails on attempt count, not on an
 * inspectable argument.
 */
interface SendPath {
  name: string;
  urlSegment: "messages" | "events";
  send: (rest: FernRestAdapter) => Promise<unknown>;
  // `AgentTools.sendEvent` alone absorbs a send failure instead of rejecting
  // with it — room telemetry, not the agent's answer — so its settled outcome
  // differs from the other three paths, which all still reject.
  assertOutcome: (settled: Promise<unknown>) => Promise<void>;
}

const rejectsWith429 = (settled: Promise<unknown>) => expect(settled).rejects.toMatchObject({ statusCode: 429 });

const SEND_PATHS: SendPath[] = [
  {
    name: "AgentTools.sendMessage",
    urlSegment: "messages",
    send: (rest) => new AgentTools({ roomId: "room-1", rest }).sendMessage("hi"),
    assertOutcome: rejectsWith429,
  },
  {
    name: "AgentTools.sendEvent",
    urlSegment: "events",
    send: (rest) => new AgentTools({ roomId: "room-1", rest }).sendEvent("hi", "task"),
    assertOutcome: (settled) => expect(settled).resolves.toEqual({ ok: false, status: "failed" }),
  },
  {
    name: "ContactCallbackTools.sendMessage",
    urlSegment: "messages",
    send: (rest) => new ContactCallbackTools(rest, "room-1").sendMessage("hi"),
    assertOutcome: rejectsWith429,
  },
  {
    name: "ContactCallbackTools.sendEvent",
    urlSegment: "events",
    send: (rest) => new ContactCallbackTools(rest, "room-1").sendEvent("hi", "task"),
    assertOutcome: rejectsWith429,
  },
];

describe("message-send retry cap holds through the tool layer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(SEND_PATHS)(
    "$name makes 3 attempts, not 4, on a sustained 429, over its own /$urlSegment route",
    async ({ urlSegment, send, assertOutcome }) => {
      const { rest, calls } = buildFakeRestAdapter(SUSTAINED_429(3));

      await assertOutcome(settleThroughRetries(send(rest)));

      expect(calls).toHaveLength(3);
      expect(calls.every((call) => call.url.includes(`/${urlSegment}`))).toBe(true);
    },
  );
});
