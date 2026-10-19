import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkingStateReporter, bindWorkingCycle, retainWorkingCycleUntil, reportToolActivity, endToolActivity, setPermissionActivity, reportMemoryActivity } from "../src/runtime/workingState";
import { overrideTools } from "../src/core/overrideTools";
import { trackTurn } from "../src/core/turn";
import { parseSessionConfig, WORKING_STATE_TTL_SECONDS } from "../src/runtime/types";
import { createDeferred } from "../src/core/deferred";
import { FakeAgentTools } from "../src/testing/FakeAgentTools";

describe("working state", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("publishes semantic changes once through nested tools proxies and repeats the current snapshot", async () => {
    const sends: unknown[] = [];
    const reporter = new WorkingStateReporter(async (working, options) => {
      sends.push({ working, ...(options.activity ? { activity: options.activity } : {}) });
    }, parseSessionConfig(), "room");
    const lease = reporter.open();
    await lease.ready;
    const tools = trackTurn(overrideTools(bindWorkingCycle(new FakeAgentTools(), lease), {}));
    reportToolActivity(tools, "lookup");
    reportToolActivity(tools, "lookup");
    await lease.flush();
    await vi.advanceTimersByTimeAsync(3000);
    endToolActivity(tools);
    await lease.flush();
    await lease.end();
    reportToolActivity(tools, "late");
    await lease.flush();
    expect(sends).toEqual([
      { working: true, activity: { kind: "reasoning" } },
      { working: true, activity: { kind: "tool_call", name: "lookup" } },
      { working: true, activity: { kind: "tool_call", name: "lookup" } },
      { working: true, activity: { kind: "reasoning" } },
      { working: false },
    ]);
  });

  it("keeps permission across another scope and reselects live tool/memory when a scope retires", async () => {
    const sends: unknown[] = [];
    const reporter = new WorkingStateReporter(async (working, options) => { sends.push(working ? options.activity : false); }, parseSessionConfig(), "room");
    const first = reporter.open();
    await first.ready;
    const a = bindWorkingCycle(new FakeAgentTools(), first);
    reportToolActivity(a, "first");
    setPermissionActivity(a, true);
    const second = reporter.open();
    await second.ready;
    const b = bindWorkingCycle(new FakeAgentTools(), second);
    reportMemoryActivity(b, true);
    endToolActivity(a);
    await second.flush();
    expect(sends.at(-1)).toEqual({ kind: "permission" });
    await first.end();
    expect(sends.at(-1)).toEqual({ kind: "memory" });
    reportMemoryActivity(b, false);
    await second.flush();
    expect(sends.at(-1)).toEqual({ kind: "reasoning" });
    expect(sends).not.toContain(false);
    await second.end();
    expect(sends.at(-1)).toBe(false);
    expect(sends.filter((sent) => sent === false)).toHaveLength(1);
  });

  it.each(["permission", "tool_call", "memory"] as const)("retires %s without clearing an overlapping control cycle", async (kind) => {
    const sends: unknown[] = [];
    const reporter = new WorkingStateReporter(async (working, options) => { sends.push(working ? options.activity : false); }, parseSessionConfig(), "room");
    const provider = reporter.open();
    await provider.ready;
    if (kind === "permission") provider.permission(true);
    else provider.observe(kind === "tool_call" ? { kind, name: "native" } : { kind });
    await provider.flush();
    const control = reporter.open();
    await control.ready;
    expect(sends.at(-1)).toEqual(kind === "tool_call" ? { kind, name: "native" } : { kind });
    await provider.end();
    expect(sends.at(-1)).toEqual({ kind: "reasoning" });
    expect(sends).not.toContain(false);
    provider.observe({ kind: "tool_call", name: "retired" });
    provider.permission(true);
    await provider.flush();
    await vi.advanceTimersByTimeAsync(3000);
    expect(sends.at(-1)).toEqual({ kind: "reasoning" });
    await control.end();
    expect(sends.at(-1)).toBe(false);
  });

  it("reselects live scopes when a heartbeat was queued before retirement", async () => {
    const sends: unknown[] = [];
    const held = createDeferred();
    const reporter = new WorkingStateReporter(async (working, options) => {
      sends.push(working ? options.activity : false);
      if (sends.length === 2) await held.promise;
    }, parseSessionConfig(), "room");
    const provider = reporter.open();
    await provider.ready;
    const control = reporter.open();
    await control.ready;
    await vi.advanceTimersByTimeAsync(2500);
    provider.observe({ kind: "tool_call", name: "retiring" });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    const retired = provider.end();
    held.resolve();
    await retired;
    expect(sends).toEqual([{ kind: "reasoning" }, { kind: "tool_call", name: "retiring" }, { kind: "reasoning" }]);
    await control.end();
    expect(sends.at(-1)).toBe(false);
  });

  it("drops queued retired updates and cannot revive capped or closed reporting", async () => {
    const held = createDeferred();
    const sends: unknown[] = [];
    const reporter = new WorkingStateReporter(async (working, options) => {
      sends.push({ working, activity: options.activity });
      if (sends.length === 1) await held.promise;
    }, parseSessionConfig({ maxWorkingStateSeconds: 4 }), "room");
    const first = reporter.open();
    first.observe({ kind: "tool_call", name: "stale" });
    const end = first.end();
    held.resolve();
    await Promise.all([first.ready, end]);
    expect(sends.map((s) => (s as { activity?: { name?: string } }).activity?.name)).not.toContain("stale");
    const second = reporter.open();
    await second.ready;
    await vi.advanceTimersByTimeAsync(4000);
    const count = sends.length;
    second.observe({ kind: "memory" });
    await second.flush();
    expect(sends).toHaveLength(count);
    await reporter.close();
    second.observe({ kind: "tool_call", name: "late" });
    await second.flush();
    expect(sends.at(-1)).toEqual({ working: false, activity: undefined });
  });

  it.each([{ kind: "unknown" }, { kind: "tool_call", name: "" }, { kind: "tool_call", name: "x".repeat(1025) }, { kind: "memory", name: "private" }, { kind: "reasoning", args: "private" }])("ignores invalid observations without interrupting liveness: %j", async (activity) => {
    const report = vi.fn().mockResolvedValue({});
    const reporter = new WorkingStateReporter(report, parseSessionConfig(), "room");
    const lease = reporter.open();
    await lease.ready;
    lease.observe(activity);
    await lease.flush();
    await vi.advanceTimersByTimeAsync(3000);
    await lease.end();
    expect(report.mock.calls.map(([working, options]) => [working, options.activity])).toEqual([
      [true, { kind: "reasoning" }], [true, { kind: "reasoning" }], [false, undefined],
    ]);
  });

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
