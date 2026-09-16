import { describe, expect, it, vi } from "vitest";

import { KeyedSingleFlight } from "../src/core/singleFlight";

describe("KeyedSingleFlight", () => {
  it("shares one in-flight operation across concurrent callers for the same key", async () => {
    let resolveStart!: (value: string) => void;
    const start = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const flight = new KeyedSingleFlight<string>();

    const first = flight.run("a", start);
    const second = flight.run("a", start);

    expect(second).toBe(first);
    expect(start).toHaveBeenCalledTimes(1);
    expect(flight.current("a")).toBe(first);

    resolveStart("done");
    await expect(first).resolves.toBe("done");
    await expect(second).resolves.toBe("done");
  });

  it("runs different keys independently and concurrently", async () => {
    const starts: Record<string, () => void> = {};
    const start = (key: string) => () =>
      new Promise<string>((resolve) => {
        starts[key] = () => resolve(key);
      });
    const flight = new KeyedSingleFlight<string>();

    const a = flight.run("a", start("a"));
    const b = flight.run("b", start("b"));

    expect(flight.current("a")).toBe(a);
    expect(flight.current("b")).toBe(b);
    expect(a).not.toBe(b);

    starts.b?.();
    await expect(b).resolves.toBe("b");
    expect(flight.current("a")).toBe(a);

    starts.a?.();
    await expect(a).resolves.toBe("a");
  });

  it("starts a genuinely new operation for the same key after the previous one settles", async () => {
    const start = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("second");
    const flight = new KeyedSingleFlight<string>();

    await expect(flight.run("a", start)).resolves.toBe("first");
    expect(flight.current("a")).toBeNull();

    const second = flight.run("a", start);
    expect(start).toHaveBeenCalledTimes(2);
    await expect(second).resolves.toBe("second");
  });

  it("clear() drops tracked keys without waiting for their operations to settle", async () => {
    let resolveFirst!: (value: string) => void;
    let resolveSecond!: (value: string) => void;
    const start = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveSecond = resolve)));
    const flight = new KeyedSingleFlight<string>();

    const first = flight.run("a", start);
    flight.clear();

    expect(flight.current("a")).toBeNull();

    // A new call for the same key starts a fresh operation immediately,
    // even though the cleared one hasn't settled yet.
    const second = flight.run("a", start);
    expect(start).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);

    resolveSecond("fresh");
    await expect(second).resolves.toBe("fresh");

    resolveFirst("stale");
    await expect(first).resolves.toBe("stale");
  });
});
