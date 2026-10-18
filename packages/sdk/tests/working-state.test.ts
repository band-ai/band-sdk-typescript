import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkingStateReporter, bindWorkingCycle, retainWorkingCycleUntil } from "../src/runtime/workingState";
import { parseSessionConfig, WORKING_STATE_TTL_SECONDS } from "../src/runtime/types";
import { createDeferred } from "../src/core/deferred";
import { FakeAgentTools } from "../src/testing/FakeAgentTools";

describe("working state", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("refreshes below the TTL budget and stops after the last overlapping lease", async () => {
    const sends: boolean[] = [];
    const config = parseSessionConfig();
    expect(config.workingKeepAliveSeconds).toBeLessThan(WORKING_STATE_TTL_SECONDS / 2);
    const reporter = new WorkingStateReporter(async (working) => { sends.push(working); }, config, "room");
    const first = reporter.open();
    await first.ready;
    const second = reporter.open();
    await second.ready;
    await vi.advanceTimersByTimeAsync(9000);
    expect(sends).toEqual([true, true, true, true]);
    await first.end();
    expect(sends.at(-1)).toBe(true);
    await second.end();
    await first.end();
    await vi.advanceTimersByTimeAsync(9000);
    expect(sends).toEqual([true, true, true, true, false]);
    await reporter.close();
  });

  it("serializes held requests, discards stale true and joins forced close", async () => {
    const held = createDeferred();
    const sends: boolean[] = [];
    let inFlight = 0;
    const reporter = new WorkingStateReporter(async (working) => {
      expect(inFlight++).toBe(0);
      sends.push(working);
      if (working) await held.promise;
      inFlight--;
    }, parseSessionConfig(), "room");
    const lease = reporter.open();
    await vi.advanceTimersByTimeAsync(0);
    const close = reporter.close();
    expect(reporter.close()).toBe(close);
    await vi.advanceTimersByTimeAsync(9000);
    expect(sends).toEqual([true]);
    held.resolve();
    await close;
    await lease.end();
    await reporter.open().ready;
    expect(sends).toEqual([true, false]);
  });

  it("orders a replacement period after pending false and ignores stale release", async () => {
    const idle = createDeferred();
    const sends: boolean[] = [];
    const reporter = new WorkingStateReporter(async (working) => {
      sends.push(working);
      if (!working) await idle.promise;
    }, parseSessionConfig(), "room");
    const first = reporter.open();
    await first.ready;
    const ending = first.end();
    const next = reporter.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(sends).toEqual([true, false]);
    idle.resolve();
    await next.ready;
    await ending;
    await first.end();
    expect(sends).toEqual([true, false, true]);
    await next.end();
  });

  it("caps refreshes without false or work cancellation and gives a fresh period its own budget", async () => {
    const sends: boolean[] = [];
    const reporter = new WorkingStateReporter(async (working) => { sends.push(working); }, parseSessionConfig({ maxWorkingStateSeconds: 4 }), "room");
    const first = reporter.open();
    await first.ready;
    await vi.advanceTimersByTimeAsync(12000);
    expect(sends).toEqual([true, true]);
    await reporter.open().end();
    expect(sends).toEqual([true, true]);
    await first.end();
    const next = reporter.open();
    await next.ready;
    await vi.advanceTimersByTimeAsync(3000);
    await next.end();
    expect(sends).toEqual([true, true, false, true, true, false]);
  });

  it("retains a provider through handler return and preserves its original rejection", async () => {
    const sends: boolean[] = [];
    const reporter = new WorkingStateReporter(async (working) => { sends.push(working); }, parseSessionConfig(), "room");
    const lease = reporter.open();
    await lease.ready;
    const provider = createDeferred();
    const error = new Error("provider failed");
    const work = retainWorkingCycleUntil(bindWorkingCycle(new FakeAgentTools(), lease), provider.promise.then(() => { throw error; }));
    const outcome = expect(work).rejects.toBe(error);
    await lease.end();
    await vi.advanceTimersByTimeAsync(3000);
    expect(sends).toEqual([true, true]);
    provider.resolve();
    await outcome;
    expect(sends).toEqual([true, true, false]);
  });

  it("debounces failures, recovers and treats typed 404 as unavailable state", async () => {
    const logger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() };
    const report = vi.fn().mockRejectedValueOnce(new Error("network")).mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({}).mockRejectedValueOnce({ statusCode: 404 }).mockResolvedValue({});
    const reporter = new WorkingStateReporter(report, parseSessionConfig(), "room", logger);
    const lease = reporter.open();
    await lease.ready;
    await vi.advanceTimersByTimeAsync(9000);
    await lease.end();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledWith("Working-state execution state unavailable", { roomId: "room" });
  });

  it("bounds initial and final attempts independently, without blocking other rooms", async () => {
    const reporter = new WorkingStateReporter(async (_working, options) => {
      await new Promise((_, reject) => options.abortSignal!.addEventListener("abort", () => reject(options.abortSignal!.reason), { once: true }));
    }, parseSessionConfig(), "slow");
    const fast = vi.fn().mockResolvedValue({});
    const other = new WorkingStateReporter(fast, parseSessionConfig(), "fast");
    const lease = reporter.open();
    const independent = other.open();
    await independent.ready;
    await independent.end();
    expect(fast).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    await lease.ready;
    const end = lease.end();
    await vi.advanceTimersByTimeAsync(2000);
    await end;
  });
});
