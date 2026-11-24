import { describe, expect, it } from "vitest";

import { createDeferred } from "../src/core/deferred";
import { Limiter } from "../src/core/singleFlight";
import { flushMicrotasks } from "./turnJournalSupport";

describe("Limiter", () => {
  it("counts the waiter a freed slot wakes, so a newcomer after it waits its turn", async () => {
    const limiter = new Limiter(2);
    const running = new Set<string>();
    let peak = 0;
    const finish = new Map<string, () => void>();
    const run = (name: string): Promise<void> =>
      limiter.run(async () => {
        running.add(name);
        peak = Math.max(peak, running.size);
        const done = createDeferred();
        finish.set(name, () => done.resolve());
        await done.promise;
        running.delete(name);
      });

    const all = [run("a"), run("b"), run("waiter")];
    await flushMicrotasks();
    expect([...running]).toEqual(["a", "b"]);

    // Freeing a slot hands it to the waiter; a newcomer arrives once the slot is freed.
    finish.get("a")!();
    await all[0];
    all.push(run("newcomer"));
    await flushMicrotasks();
    expect([...running].sort()).toEqual(["b", "waiter"]);

    finish.get("b")!();
    await flushMicrotasks();
    expect([...running].sort()).toEqual(["newcomer", "waiter"]);

    finish.get("waiter")!();
    finish.get("newcomer")!();
    await Promise.all(all);
    expect(peak).toBe(2);
  });

  it("frees the slot of a body that fails", async () => {
    const limiter = new Limiter(1);
    await expect(limiter.run(async () => {
      throw new Error("failed");
    })).rejects.toThrow("failed");
    await expect(limiter.run(async () => "ran")).resolves.toBe("ran");
  });
});
