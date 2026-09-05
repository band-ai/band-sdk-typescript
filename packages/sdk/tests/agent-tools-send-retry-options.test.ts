import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FernRestAdapter } from "../src/client/rest/FernRestAdapter";
import { EVENT_SEND_FAILED_STATUS } from "../src/contracts/content";
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
}

// sendMessage is the agent's answer, so exhausted retries reject. sendEvent is room
// telemetry: AgentTools/ContactCallbackTools absorb any transport failure and resolve
// { ok: false, status: "failed" } instead.
const MESSAGE_SEND_PATHS: SendPath[] = [
  {
    name: "AgentTools.sendMessage",
    urlSegment: "messages",
    send: (rest) => new AgentTools({ roomId: "room-1", rest }).sendMessage("hi"),
  },
  {
    name: "ContactCallbackTools.sendMessage",
    urlSegment: "messages",
    send: (rest) => new ContactCallbackTools(rest, "room-1").sendMessage("hi"),
  },
];

const EVENT_SEND_PATHS: SendPath[] = [
  {
    name: "AgentTools.sendEvent",
    urlSegment: "events",
    send: (rest) => new AgentTools({ roomId: "room-1", rest }).sendEvent("hi", "task"),
  },
  {
    name: "ContactCallbackTools.sendEvent",
    urlSegment: "events",
    send: (rest) => new ContactCallbackTools(rest, "room-1").sendEvent("hi", "task"),
  },
];

describe("message-send retry cap holds through the tool layer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(MESSAGE_SEND_PATHS)(
    "$name makes 3 attempts, not 4, on a sustained 429, over its own /$urlSegment route, and rejects",
    async ({ urlSegment, send }) => {
      const { rest, calls } = buildFakeRestAdapter(SUSTAINED_429(3));

      await expect(settleThroughRetries(send(rest))).rejects.toMatchObject({ statusCode: 429 });

      expect(calls).toHaveLength(3);
      expect(calls.every((call) => call.url.includes(`/${urlSegment}`))).toBe(true);
    },
  );

  it.each(EVENT_SEND_PATHS)(
    "$name makes 3 attempts, not 4, on a sustained 429, over its own /$urlSegment route, and resolves { ok: false }",
    async ({ urlSegment, send }) => {
      const { rest, calls } = buildFakeRestAdapter(SUSTAINED_429(3));

      await expect(settleThroughRetries(send(rest))).resolves.toEqual({
        ok: false,
        status: EVENT_SEND_FAILED_STATUS,
        message: "Status code: 429",
      });

      expect(calls).toHaveLength(3);
      expect(calls.every((call) => call.url.includes(`/${urlSegment}`))).toBe(true);
    },
  );
});
