import { describe, expect, it } from "vitest";

import { createDeferred } from "../src/core/deferred";
import { KeyedSerializer } from "../src/core/singleFlight";

describe("KeyedSerializer", () => {
  it("runs bodies under one key one at a time and bodies under different keys independently", async () => {
    const serializer = new KeyedSerializer();
    const order: string[] = [];
    const firstHeld = createDeferred();
    const firstStarted = createDeferred();

    const first = serializer.run("a", async () => {
      order.push("a1-start");
      firstStarted.resolve();
      await firstHeld.promise;
      order.push("a1-end");
    });
    const second = serializer.run("a", async () => {
      order.push("a2");
    });
    const other = serializer.run("b", async () => {
      order.push("b");
    });

    await firstStarted.promise;
    await other;
    expect(order).toEqual(["a1-start", "b"]);

    firstHeld.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["a1-start", "b", "a1-end", "a2"]);
  });

  it("runs the next body under a key after the previous one rejected, and hands each its own outcome", async () => {
    const serializer = new KeyedSerializer();
    const failed = serializer.run("a", () => Promise.reject(new Error("first failed")));
    const next = serializer.run("a", () => Promise.resolve("second"));

    await expect(failed).rejects.toThrow("first failed");
    await expect(next).resolves.toBe("second");
  });
});
