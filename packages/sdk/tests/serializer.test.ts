import { describe, expect, it } from "vitest";

import { Serializer } from "../src/core/singleFlight";

describe("Serializer", () => {
  it("runs each enqueued body only after the previous one has settled", async () => {
    const serializer = new Serializer();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;

    const first = serializer.run(async () => {
      order.push("first-start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first-end");
      return "a";
    });
    const second = serializer.run(async () => {
      order.push("second-start");
      return "b";
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["first-start"]);

    releaseFirst?.();
    await expect(first).resolves.toBe("a");
    await expect(second).resolves.toBe("b");
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("preserves FIFO admission order across many enqueued calls regardless of each body's own delay", async () => {
    const serializer = new Serializer();
    const started: number[] = [];
    const delaysMs = [15, 0, 5];

    const runs = delaysMs.map((delayMs, index) =>
      serializer.run(async () => {
        started.push(index);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return index;
      }),
    );

    await expect(Promise.all(runs)).resolves.toEqual([0, 1, 2]);
    // If bodies ran concurrently, the shortest delay (index 2) would start
    // and finish while the longest (index 0) was still pending — instead
    // each body only starts once the previous one has fully settled.
    expect(started).toEqual([0, 1, 2]);
  });

  it("does not block the next queued body when a body rejects, and gives each caller its own outcome", async () => {
    const serializer = new Serializer();
    const failing = serializer.run(async () => {
      throw new Error("boom");
    });
    const next = serializer.run(async () => "recovered");

    await expect(failing).rejects.toThrow("boom");
    await expect(next).resolves.toBe("recovered");
  });

  it("gives each caller a distinct promise for its own body, unlike SingleFlight's shared in-flight promise", () => {
    const serializer = new Serializer();
    const first = serializer.run(async () => "a");
    const second = serializer.run(async () => "b");

    expect(first).not.toBe(second);
  });
});
