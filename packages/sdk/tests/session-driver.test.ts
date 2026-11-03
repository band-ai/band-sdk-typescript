import { describe, expect, it } from "vitest";
import { SessionPolicy } from "@band-ai/band-sdk-core";

import { MAX_TIMER_DELAY_MS, SessionDriver } from "../src/platform/streaming/sessionDriver";

function driverAt(clock: { nowS: number }): SessionDriver {
  return new SessionDriver({ policy: SessionPolicy.default(), now: () => clock.nowS, jitter: () => 1 });
}

describe("SessionDriver", () => {
  it("caps a server hint longer than a Node timer can hold, which would otherwise fire after 1 ms", () => {
    const driver = driverAt({ nowS: 0 });
    driver.begin();
    driver.beginAttempt();

    const verdict = driver.onUpgradeRejected(503, 10_000_000);

    expect(verdict).toEqual({ kind: "retry", delayMs: MAX_TIMER_DELAY_MS });
    expect(driver.pendingDelayMs).toBe(MAX_TIMER_DELAY_MS);
  });

  it("starts a fresh run after a terminal verdict, since core never revives a dead Session", () => {
    const driver = driverAt({ nowS: 0 });
    driver.begin();
    driver.beginAttempt();
    expect(driver.onUpgradeRejected(403, null)).toEqual({ kind: "terminal", rapidDisconnect: false });
    expect(driver.beginAttempt()).toBe("dead");

    expect(driver.begin()).toBe(true);
    expect(driver.beginAttempt()).toBe("proceed");
  });

  it("does not let a local end be undone by a late attempt", () => {
    const driver = driverAt({ nowS: 0 });
    driver.begin();
    driver.end();

    expect(driver.beginAttempt()).toBe("ended");
    expect(driver.onSocketClose(1000)).toEqual({ kind: "ended" });
  });
});
