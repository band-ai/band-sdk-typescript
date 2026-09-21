import { describe, expect, it, vi } from "vitest";

import { SingleFlight } from "../src/core/singleFlight";

describe("SingleFlight", () => {
  it("shares one in-flight operation across concurrent callers", async () => {
    let resolveStart!: (value: string) => void;
    const start = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const flight = new SingleFlight<string>();

    const first = flight.run(start);
    const second = flight.run(start);

    expect(second).toBe(first);
    expect(start).toHaveBeenCalledTimes(1);
    expect(flight.current).toBe(first);

    resolveStart("done");
    await expect(first).resolves.toBe("done");
    await expect(second).resolves.toBe("done");
  });

  it("starts a genuinely new operation after the previous one resolves", async () => {
    const start = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("second");
    const flight = new SingleFlight<string>();

    await expect(flight.run(start)).resolves.toBe("first");
    expect(flight.current).toBeNull();

    const second = flight.run(start);
    expect(start).toHaveBeenCalledTimes(2);
    await expect(second).resolves.toBe("second");
  });

  it("starts a genuinely new operation after the previous one rejects", async () => {
    const start = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("recovered");
    const flight = new SingleFlight<string>();

    await expect(flight.run(start)).rejects.toThrow("boom");
    expect(flight.current).toBeNull();

    const second = flight.run(start);
    expect(start).toHaveBeenCalledTimes(2);
    await expect(second).resolves.toBe("recovered");
  });

  it("still coalesces callers that arrive while the pending operation is failing", async () => {
    let rejectStart!: (error: Error) => void;
    const start = vi.fn(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectStart = reject;
        }),
    );
    const flight = new SingleFlight<string>();

    const first = flight.run(start);
    const second = flight.run(start);
    expect(start).toHaveBeenCalledTimes(1);

    rejectStart(new Error("boom"));
    await expect(first).rejects.toThrow("boom");
    await expect(second).rejects.toThrow("boom");
    expect(flight.current).toBeNull();
  });
});
