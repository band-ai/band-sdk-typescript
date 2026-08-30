import { BandClient } from "@band-ai/rest-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

import { FernRestAdapter } from "../src/client/rest/FernRestAdapter";
import type { FernBandClientLike } from "../src/client/rest/types";
import { AgentTools } from "../src/runtime/tools/AgentTools";
import { ContactCallbackTools } from "../src/runtime/tools/ContactCallbackTools";
import { createFakeFetchServer, type FakeResponseSpec } from "./support/fakeFetchServer";
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
function buildFakeClient(responses: FakeResponseSpec[]) {
  const { fetch, calls } = createFakeFetchServer(responses);
  const client = new BandClient({
    apiKey: "test-key",
    baseUrl: "http://fake-band.test",
    fetch,
  }) as unknown as FernBandClientLike;
  return { rest: new FernRestAdapter(client), calls };
}

const SUSTAINED_429 = (attempts: number): FakeResponseSpec[] =>
  Array.from({ length: attempts }, () => ({ status: 429, headers: { "Retry-After": "1" } }));

describe("message-send retry cap holds through the tool layer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("AgentTools.sendMessage makes 3 attempts, not 4, on a sustained 429", async () => {
    const { rest, calls } = buildFakeClient(SUSTAINED_429(3));
    const tools = new AgentTools({ roomId: "room-1", rest });

    await expect(settleThroughRetries(tools.sendMessage("hi"))).rejects.toMatchObject({
      statusCode: 429,
    });
    expect(calls).toHaveLength(3);
  });

  it("AgentTools.sendEvent makes 3 attempts, not 4, on a sustained 429", async () => {
    const { rest, calls } = buildFakeClient(SUSTAINED_429(3));
    const tools = new AgentTools({ roomId: "room-1", rest });

    await expect(settleThroughRetries(tools.sendEvent("hi", "task"))).rejects.toMatchObject({
      statusCode: 429,
    });
    expect(calls).toHaveLength(3);
  });

  it("ContactCallbackTools.sendMessage makes 3 attempts, not 4, on a sustained 429", async () => {
    const { rest, calls } = buildFakeClient(SUSTAINED_429(3));
    const tools = new ContactCallbackTools(rest, "room-1");

    await expect(settleThroughRetries(tools.sendMessage("hi"))).rejects.toMatchObject({
      statusCode: 429,
    });
    expect(calls).toHaveLength(3);
  });

  it("ContactCallbackTools.sendEvent makes 3 attempts, not 4, on a sustained 429", async () => {
    const { rest, calls } = buildFakeClient(SUSTAINED_429(3));
    const tools = new ContactCallbackTools(rest, "room-1");

    await expect(settleThroughRetries(tools.sendEvent("hi", "task"))).rejects.toMatchObject({
      statusCode: 429,
    });
    expect(calls).toHaveLength(3);
  });
});
