import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SUSTAINED_429 } from "./support/fakeFetchServer";
import { buildFakeRestAdapter } from "./support/fakeRestAdapter";
import { settleThroughRetries } from "./support/settleThroughRetries";

/**
 * Mocking the client method directly only proves the adapter calls it the
 * expected number of times — it says nothing about whether `maxRetries`
 * reaches the transport's own retry logic. These tests wire a real
 * `BandClient` to a fake `fetch`, so `maxRetries` has to survive all the way
 * through the generated client's retry/backoff to pass.
 */

describe("FernRestAdapter retry boundary (real generated client)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("getAgentMe: exhausts its 4-attempt budget (maxRetries: 3) then succeeds", async () => {
    const { rest, calls } = buildFakeRestAdapter([
      ...SUSTAINED_429(3),
      {
        status: 200,
        body: { id: "a1", name: "Agent", description: null, handle: "@agent", owner_uuid: "owner-1" },
      },
    ]);

    const result = await settleThroughRetries(rest.getAgentMe());

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
    const { rest, calls } = buildFakeRestAdapter(SUSTAINED_429(4));

    await expect(settleThroughRetries(rest.getAgentMe())).rejects.toMatchObject({
      statusCode: 429,
    });
    expect(calls).toHaveLength(4);
  });

  it("createChatMessage: exhausts its 3-attempt budget (maxRetries: 2) then succeeds", async () => {
    const { rest, calls } = buildFakeRestAdapter([
      ...SUSTAINED_429(2),
      { status: 200, body: { ok: true, id: "msg-1" } },
    ]);

    const result = await settleThroughRetries(
      rest.createChatMessage("room-1", { content: "hello", messageType: "text" }),
    );

    expect(result).toEqual({ ok: true, id: "msg-1" });
    expect(calls).toHaveLength(3);
  });

  it("createChatMessage: an explicit caller maxRetries wins over the operation's own cap", async () => {
    const { rest, calls } = buildFakeRestAdapter(SUSTAINED_429(1));

    await expect(
      settleThroughRetries(
        rest.createChatMessage("room-1", { content: "hello", messageType: "text" }, { maxRetries: 0 }),
      ),
    ).rejects.toMatchObject({ statusCode: 429 });

    expect(calls).toHaveLength(1);
  });
});
