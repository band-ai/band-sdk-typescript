import { describe, expect, it, vi } from "vitest";

import { FernRestAdapter } from "../src/client/rest/FernRestAdapter";
import { BandLink } from "../src/platform/BandLink";
import { sleep } from "../src/core/sleep";
import { FakeRestApi } from "./testUtils";

function rateLimitError(): Error & { statusCode: number } {
  return Object.assign(new Error("rate limited"), { statusCode: 429 });
}

/** The adapter's first getAgentMe backoff is 2s plus jitter; anything well under that proves the wait was cut short. */
const FIRST_BACKOFF_MS = 2_000;
const ABORT_AFTER_MS = 50;
const SETTLE_BUDGET_MS = 750;

describe("sleep honours an abort signal", () => {
  it("resolves immediately when the signal is already aborted", async () => {
    const started = Date.now();
    await sleep(FIRST_BACKOFF_MS, { signal: AbortSignal.abort() });

    expect(Date.now() - started).toBeLessThan(SETTLE_BUDGET_MS);
  });

  it("resolves as soon as the signal aborts mid-wait", async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), ABORT_AFTER_MS);

    await sleep(FIRST_BACKOFF_MS, { signal: controller.signal });

    expect(Date.now() - started).toBeLessThan(SETTLE_BUDGET_MS);
  });

  it("still waits the full delay when nothing aborts", async () => {
    const started = Date.now();
    await sleep(60);

    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });
});

describe("REST requests can be cancelled", () => {
  it("forwards abortSignal to the underlying client", async () => {
    const controller = new AbortController();
    const getAgentMe = vi.fn(async () => ({ data: { id: "a1", name: "Agent" } }));
    const adapter = new FernRestAdapter({ agentApiIdentity: { getAgentMe } });

    await adapter.getAgentMe({ abortSignal: controller.signal });

    expect(getAgentMe).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: controller.signal }),
    );
  });

  it("abandons the rate-limit backoff when the caller aborts mid-wait", async () => {
    const controller = new AbortController();
    const getAgentMe = vi.fn(() => Promise.reject(rateLimitError()));
    const adapter = new FernRestAdapter({ agentApiIdentity: { getAgentMe } });

    const started = Date.now();
    setTimeout(() => controller.abort(), ABORT_AFTER_MS);

    await expect(
      adapter.getAgentMe({ abortSignal: controller.signal }),
    ).rejects.toMatchObject({ statusCode: 429 });

    expect(Date.now() - started).toBeLessThan(SETTLE_BUDGET_MS);
    // One attempt, then the aborted backoff — no retry after cancellation.
    expect(getAgentMe).toHaveBeenCalledTimes(1);
  });

  it("still retries through the full backoff when nothing aborts", async () => {
    const getAgentMe = vi.fn()
      .mockRejectedValueOnce(rateLimitError())
      .mockResolvedValueOnce({ data: { id: "a1", name: "Agent" } });
    const adapter = new FernRestAdapter({ agentApiIdentity: { getAgentMe } });

    await expect(adapter.getAgentMe()).resolves.toMatchObject({ id: "a1" });
    expect(getAgentMe).toHaveBeenCalledTimes(2);
  }, FIRST_BACKOFF_MS * 3);
});

describe("BandLink message-status calls accept an abort signal", () => {
  function linkWith(restApi: FakeRestApi): BandLink {
    return new BandLink({
      agentId: "agent-1",
      apiKey: "key-1",
      restApi,
      transport: {
        connect: async () => undefined,
        disconnect: async () => undefined,
        isConnected: () => true,
        join: async () => undefined,
        leave: async () => undefined,
        runForever: async () => undefined,
      },
    });
  }

  it.each([
    ["markProcessing", "markMessageProcessing"],
    ["markProcessed", "markMessageProcessed"],
    ["markFailed", "markMessageFailed"],
  ] as const)("%s forwards the signal to %s", async (linkMethod, restMethod) => {
    const controller = new AbortController();
    const captured: Array<AbortSignal | undefined> = [];
    const restApi = new FakeRestApi({
      [restMethod]: (...args: unknown[]) => {
        const options = args.at(-1) as { abortSignal?: AbortSignal } | undefined;
        captured.push(options?.abortSignal);
        return {};
      },
    });
    const link = linkWith(restApi);

    if (linkMethod === "markFailed") {
      await link.markFailed("room-1", "message-1", "boom", {
        abortSignal: controller.signal,
      });
    } else {
      await link[linkMethod]("room-1", "message-1", {
        abortSignal: controller.signal,
      });
    }

    expect(captured).toEqual([controller.signal]);
  });

  it("cancels an in-flight mark request when the signal aborts", async () => {
    const controller = new AbortController();
    const restApi = new FakeRestApi({
      markMessageProcessing: async (
        _chatId: string,
        _messageId: string,
        options?: { abortSignal?: AbortSignal },
      ) => {
        const signal = options?.abortSignal;
        return await new Promise<Record<string, unknown>>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("request aborted")),
            { once: true },
          );
        });
      },
    });
    const link = linkWith(restApi);

    const pending = link.markProcessing("room-1", "message-1", {
      abortSignal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toThrow("request aborted");
  });
});
