import { afterEach, describe, expect, it, vi } from "vitest";

import { ConsoleLogger, NoopLogger, resolveLogger, type Logger } from "../src/core/logger";

describe("ConsoleLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("redacts sensitive keys before writing error context", () => {
    const logger = new ConsoleLogger();
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    logger.error("boom", {
      apiKey: "secret",
      nested: {
        authorization: "Bearer abc",
        safe: "ok",
      },
    });

    expect(writeSpy).toHaveBeenCalledOnce();
    expect(String(writeSpy.mock.calls[0]?.[0])).toContain("\"apiKey\":\"[REDACTED]\"");
    expect(String(writeSpy.mock.calls[0]?.[0])).toContain("\"authorization\":\"[REDACTED]\"");
    expect(String(writeSpy.mock.calls[0]?.[0])).toContain("\"safe\":\"ok\"");
  });

  it("handles circular error context safely", () => {
    const logger = new ConsoleLogger();
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const context: Record<string, unknown> = {};
    context.self = context;

    logger.error("boom", context);

    expect(writeSpy).toHaveBeenCalledOnce();
    expect(String(writeSpy.mock.calls[0]?.[0])).toContain("[Circular]");
  });
});

describe("resolveLogger", () => {
  it("returns a NoopLogger when no logger is given", () => {
    expect(resolveLogger()).toBeInstanceOf(NoopLogger);
  });

  it("is idempotent: resolving an already-resolved logger returns the same instance instead of wrapping it again", () => {
    const inner: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const once = resolveLogger(inner);
    const twice = resolveLogger(once);
    expect(twice).toBe(once);
  });

  it("still guards a throwing inner logger's error, even after being resolved twice", () => {
    const inner: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(() => {
        throw new Error("logger boom");
      }),
    };
    const guarded = resolveLogger(resolveLogger(inner));
    expect(() => guarded.error("boom")).not.toThrow();
    expect(inner.error).toHaveBeenCalledTimes(1);
  });

  it("propagates an async inner logger's real promise, so a caller can still catch its rejection", async () => {
    // `Logger.warn` is typed `void`, but TS's void-return bivariance lets an
    // `async` implementation satisfy it. A caller that wants to know about a
    // rejection guards it by `.catch()`-ing whatever `logger.warn(...)`
    // actually returns -- if the guard here drops that return value instead
    // of forwarding it, the rejection has nothing attached to it anywhere
    // and surfaces as an unhandled rejection instead.
    const inner: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(async () => {
        throw new Error("logging sink is down");
      }),
      error: vi.fn(),
    };
    const guarded = resolveLogger(inner);

    await expect(Promise.resolve(guarded.warn("boom")).catch((error: unknown) => error))
      .resolves.toBeInstanceOf(Error);
  });

  it("does not surface an unhandled rejection when a caller never attaches its own catch", async () => {
    // Most fire-and-forget `logger.warn(...)` call sites across the SDK's
    // failure paths never consume the promise `guarded.warn(...)` returns
    // (`Logger.warn` is typed `void`) -- if `GuardedLogger` didn't guard the
    // async case itself, every one of those call sites would leak an
    // unhandled rejection whenever a caller-supplied async logger rejects.
    //
    // Asserted by spying on the inner promise's own `.catch`, not on Node's
    // `unhandledRejection` event: vitest's worker sandbox does not deliver
    // that event to a test's own `process.on` listener, so a promise-level
    // assertion is what actually distinguishes "guarded internally" from
    // "silently leaked".
    let rejectInner!: (error: unknown) => void;
    const innerPromise = new Promise<void>((_, reject) => { rejectInner = reject; });
    const catchSpy = vi.spyOn(innerPromise, "catch");
    const inner: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(() => innerPromise as unknown as void),
      error: vi.fn(),
    };
    const guarded = resolveLogger(inner);

    guarded.warn("boom");
    expect(catchSpy).toHaveBeenCalledTimes(1);

    // Settle the promise so it doesn't dangle past the test.
    rejectInner(new Error("logging sink is down"));
    await innerPromise.catch(() => undefined);
  });
});
