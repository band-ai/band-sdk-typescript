import { BandClient } from "@band-ai/rest-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FernRestAdapter } from "../src/client/rest/FernRestAdapter";
import type { FernBandClientLike } from "../src/client/rest/types";
import { createFakeFetchServer, type FakeResponseSpec } from "./support/fakeFetchServer";

/**
 * INT-1258: FernRestAdapter used to wrap a hand-rolled retry loop around the
 * generated `@band-ai/rest-client`, which already retries 408/429/5xx via
 * `maxRetries`. Mocking the client *method* directly (as the coverage tests
 * do) proves the adapter calls that mock the right number of times, but
 * never exercises the generated retry path itself — a dropped `maxRetries`
 * would pass those tests silently.
 *
 * These tests build a real `BandClient` wired to a fake `fetch`, so the
 * adapter's `maxRetries` has to survive all the way through
 * `requestWithRetries.js` to pass.
 */

function buildAdapter(responses: FakeResponseSpec[]) {
  const { fetch, calls } = createFakeFetchServer(responses);
  const client = new BandClient({
    apiKey: "test-key",
    baseUrl: "http://fake-band.test",
    fetch,
  }) as unknown as FernBandClientLike;
  return { adapter: new FernRestAdapter(client), calls };
}

async function settleThroughRetries<T>(promise: Promise<T>): Promise<T> {
  const settled = promise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
  await vi.runAllTimersAsync();
  const outcome = await settled;
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

describe("FernRestAdapter retry boundary (real generated client)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("getAgentMe: exhausts its 4-attempt budget (maxRetries: 3) then succeeds", async () => {
    const { adapter, calls } = buildAdapter([
      { status: 429, headers: { "Retry-After": "1" } },
      { status: 429, headers: { "Retry-After": "1" } },
      { status: 429, headers: { "Retry-After": "1" } },
      {
        status: 200,
        body: { id: "a1", name: "Agent", description: null, handle: "@agent", owner_uuid: "owner-1" },
      },
    ]);

    const result = await settleThroughRetries(adapter.getAgentMe());

    expect(result).toEqual({
      id: "a1",
      name: "Agent",
      description: null,
      handle: "@agent",
      ownerUuid: "owner-1",
    });
    expect(calls).toHaveLength(4);
  });

  it("getAgentMe: never exceeds its 4-attempt budget and surfaces the terminal 429", async () => {
    const { adapter, calls } = buildAdapter([
      { status: 429, headers: { "Retry-After": "1" } },
      { status: 429, headers: { "Retry-After": "1" } },
      { status: 429, headers: { "Retry-After": "1" } },
      { status: 429, headers: { "Retry-After": "1" } },
    ]);

    await expect(settleThroughRetries(adapter.getAgentMe())).rejects.toMatchObject({
      statusCode: 429,
    });
    expect(calls).toHaveLength(4);
  });

  it("createChatMessage: exhausts its 3-attempt budget (maxRetries: 2) then succeeds", async () => {
    const { adapter, calls } = buildAdapter([
      { status: 429, headers: { "Retry-After": "1" } },
      { status: 429, headers: { "Retry-After": "1" } },
      { status: 200, body: { ok: true, id: "msg-1" } },
    ]);

    const result = await settleThroughRetries(
      adapter.createChatMessage("room-1", { content: "hello", messageType: "text" }),
    );

    expect(result).toEqual({ ok: true, id: "msg-1" });
    expect(calls).toHaveLength(3);
  });
});
