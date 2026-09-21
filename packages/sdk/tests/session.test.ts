import { describe, expect, it, vi } from "vitest";

import { Session } from "../src/platform/Session";

describe("Session", () => {
  it("couples activity with epoch invalidation across begin and deactivate", () => {
    const session = new Session();

    expect(session.isActive).toBe(false);
    const first = session.begin();
    expect(session.isActive).toBe(true);
    expect(session.isStale(first)).toBe(false);

    session.deactivate();
    expect(session.isActive).toBe(false);
    expect(session.isStale(first)).toBe(true);

    const second = session.begin();
    expect(second).toBeGreaterThan(first);
    expect(session.isActive).toBe(true);
  });

  it("clears a reconnect observer at most once", () => {
    const session = new Session();
    const teardown = vi.fn();
    session.reconnectObserverTeardown = teardown;

    session.clearReconnectObserver();
    session.clearReconnectObserver();

    expect(teardown).toHaveBeenCalledTimes(1);
    expect(session.reconnectObserverTeardown).toBeNull();
  });
});
