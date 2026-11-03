import { describe, expect, it } from "vitest";
import { SessionPolicy } from "@band-ai/band-sdk-core";

import { RuntimeStateError } from "../src/core/errors";
import { MAX_SETTIMEOUT_DELAY_MS } from "../src/core/deadline";
import { WebSocketDisconnectError, type WebSocketUpgradeDisconnectReason } from "../src/platform/streaming/disconnectReason";
import { SessionRun } from "../src/platform/streaming/sessionRun";

function runAt(clock: { nowS: number }): SessionRun {
  return new SessionRun({ policy: SessionPolicy.default(), now: () => clock.nowS, jitter: () => 1 });
}

function refusal(status: number, retryAfter: number | null): WebSocketUpgradeDisconnectReason {
  return { source: "upgrade", status, code: "upgrade_rejected", message: "refused", retryable: true, retryAfter, requestId: null };
}

describe("SessionRun", () => {
  it("caps a server hint longer than a Node timer can hold, which would otherwise fire after 1 ms", () => {
    const run = runAt({ nowS: 0 });
    run.beginAttempt();

    const verdict = run.onUpgradeRejected(refusal(503, 10_000_000));

    expect(verdict).toMatchObject({ kind: "retry", delayMs: MAX_SETTIMEOUT_DELAY_MS });
    expect(run.pendingDelayMs).toBe(MAX_SETTIMEOUT_DELAY_MS);
    expect(run.lastReason).toMatchObject({ status: 503 });
  });

  it("ends on a terminal verdict, aborting its signal with the non-retryable reason", () => {
    const run = runAt({ nowS: 0 });
    run.beginAttempt();

    expect(run.onUpgradeRejected(refusal(403, null))).toMatchObject({ kind: "terminal", reason: { status: 403, retryable: false } });

    expect(run.isLive).toBe(false);
    expect(run.signal.reason).toBeInstanceOf(WebSocketDisconnectError);
    expect(run.beginAttempt()).toBe(false);
  });

  it("is never connected once stopped, and ignores what arrives after", () => {
    const run = runAt({ nowS: 0 });
    run.beginAttempt();
    run.onConnected();
    run.markConnected();
    const stop = new RuntimeStateError("stopped");

    run.stop(stop);

    expect(run.isConnected).toBe(false);
    expect(run.signal.reason).toBe(stop);
    expect(run.beginAttempt()).toBe(false);
    expect(run.onSocketClose({ code: 1000 })).toEqual({ kind: "ended" });
  });
});
