import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDeferred } from "../src/core/deferred";
import { DecisionRegistry, isAuthorizedSender } from "../src/adapters/shared/decisions";

describe("DecisionRegistry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("replaces an unclaimed redelivery, and the replaced entry's timer never fires", async () => {
    const registry = new DecisionRegistry<string>();
    const expired: string[] = [];
    registry.register("first", "ask-1");
    registry.startTimeout("ask-1", 100, (payload) => {
      expired.push(payload);
    });

    expect(registry.register("second", "ask-1")).toBe("ask-1");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(expired).toEqual([]);
    expect(registry.get("ask-1")).toBe("second");
  });

  it("refuses a redelivery of a claimed key and leaves the claimant's entry alone", () => {
    const registry = new DecisionRegistry<string>();
    registry.register("original", "ask-1");
    registry.tryClaim("ask-1");

    expect(registry.register("redelivered", "ask-1")).toBeNull();
    expect(registry.get("ask-1")).toBe("original");
    expect(registry.tryClaim("ask-1")).toBeUndefined();
  });

  it("never runs the timeout once a reply claimed the entry before the deadline", async () => {
    const registry = new DecisionRegistry<string>();
    const onTimeout = vi.fn();
    const token = registry.register("ask");
    registry.startTimeout(token, 100, onTimeout);

    expect(registry.tryClaim(token)).toBe("ask");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("makes a reply lose once the expiry has claimed, even while its handler is still running", async () => {
    const registry = new DecisionRegistry<string>();
    const handlerHeld = createDeferred();
    const token = registry.register("ask");
    registry.startTimeout(token, 100, async () => handlerHeld.promise);

    await vi.advanceTimersByTimeAsync(100);

    expect(registry.tryClaim(token)).toBeUndefined();
    expect(registry.withdraw(token)).toBeUndefined();
    handlerHeld.resolve();
  });

  it("logs a rejecting timeout handler instead of leaving an unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const registry = new DecisionRegistry<string>(logger);
    const token = registry.register("ask");
    registry.startTimeout(token, 100, async () => {
      throw new Error("expiry reply failed");
    });

    try {
      await vi.advanceTimersByTimeAsync(100);
      await vi.waitFor(() => expect(logger.warn).toHaveBeenCalled());
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("never fires an Infinity timeout", async () => {
    const registry = new DecisionRegistry<string>();
    const onTimeout = vi.fn();
    const token = registry.register("ask");
    registry.startTimeout(token, Infinity, onTimeout);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(onTimeout).not.toHaveBeenCalled();
    expect(registry.tryClaim(token)).toBe("ask");
  });

  it("cancels only unclaimed entries back to the caller and lets a claimed expiry complete", async () => {
    const registry = new DecisionRegistry<{ room: string; name: string }>();
    const handlerHeld = createDeferred();
    const completed: string[] = [];
    const expiring = registry.register({ room: "a", name: "expiring" });
    registry.register({ room: "a", name: "waiting" });
    registry.register({ room: "b", name: "other-room" });
    registry.startTimeout(expiring, 100, async (payload) => {
      await handlerHeld.promise;
      completed.push(payload.name);
    });
    await vi.advanceTimersByTimeAsync(100);

    const cancelled = registry.cancelAll((payload) => payload.room === "a");
    handlerHeld.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(cancelled.map((payload) => payload.name)).toEqual(["waiting"]);
    expect(completed).toEqual(["expiring"]);
    expect(registry.keys().map((token) => registry.get(token)?.name)).toEqual(["other-room"]);
  });
});

describe("isAuthorizedSender", () => {
  it("admits nobody through an empty allowlist and anyone when unrestricted", () => {
    expect(isAuthorizedSender(new Set(), "owner")).toBe(false);
    expect(isAuthorizedSender(new Set(["owner"]), "intruder")).toBe(false);
    expect(isAuthorizedSender(new Set(["owner"]), "owner")).toBe(true);
    expect(isAuthorizedSender(null, "anyone")).toBe(true);
  });
});
