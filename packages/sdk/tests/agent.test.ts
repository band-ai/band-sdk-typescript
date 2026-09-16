import { describe, expect, it, vi } from "vitest";

import { Agent } from "../src/agent/Agent";

describe("Agent", () => {
  it("stops the runtime while startup is pending", async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = () => {
        resolve();
      };
    });
    const mockRuntime = {
      start: vi.fn(async () => {
        await startGate;
      }),
      stop: vi.fn(() => Promise.resolve(true)),
      runForever: vi.fn(() => Promise.resolve()),
      name: "test",
      description: "test",
      contactConfiguration: undefined,
      isContactsSubscribed: false,
    };
    const mockAdapter = {
      onEvent: vi.fn(() => Promise.resolve()),
      onStarted: vi.fn(() => Promise.resolve()),
      onCleanup: vi.fn(() => Promise.resolve()),
      onRuntimeStop: vi.fn(() => Promise.resolve()),
    };
    const agent = new Agent(mockRuntime as never, mockAdapter as never);

    const startPromise = agent.start();
    const stopPromise = agent.stop();

    expect(mockRuntime.stop).toHaveBeenCalledTimes(1);

    releaseStart();
    await startPromise;
    await expect(stopPromise).resolves.toBe(true);

    expect(mockRuntime.stop).toHaveBeenCalledTimes(1);
  });

  it("does not invoke adapter onRuntimeStop outside PlatformRuntime.stop", async () => {
    const mockRuntime = {
      start: vi.fn(() => Promise.resolve()),
      stop: vi.fn(() => Promise.resolve(true)),
      runForever: vi.fn(() => Promise.resolve()),
      name: "test",
      description: "test",
      contactConfiguration: undefined,
      isContactsSubscribed: false,
    };
    const mockAdapter = {
      onEvent: vi.fn(() => Promise.resolve()),
      onStarted: vi.fn(() => Promise.resolve()),
      onCleanup: vi.fn(() => Promise.resolve()),
      onRuntimeStop: vi.fn(() => Promise.resolve()),
    };
    const agent = new Agent(mockRuntime as never, mockAdapter as never);

    await agent.start();
    await agent.stop();

    expect(mockRuntime.stop).toHaveBeenCalledTimes(1);
    expect(mockAdapter.onRuntimeStop).not.toHaveBeenCalled();
  });
});
