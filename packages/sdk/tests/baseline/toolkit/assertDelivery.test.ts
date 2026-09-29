import { describe, expect, it } from "vitest";

import { assertDeliveryStatus } from "./assertDelivery";
import { DELIVERY_STATUS, NO_STORED_STATUS, type DeliveryState, type StalledWait } from "./observeDelivery";

const processed: DeliveryState = { status: DELIVERY_STATUS.processed, processedAt: new Date("2026-01-01T00:00:00Z") };

const stalled: StalledWait = {
  waitedMs: 180_000,
  waitStartedAt: new Date("2026-01-01T00:00:01Z"),
  readAt: new Date("2026-01-01T00:03:01Z"),
  stored: [
    { id: "m1", contentPrefix: "Remember: teal", status: DELIVERY_STATUS.processing, processedAt: null, awaited: false },
    { id: "m2", contentPrefix: "Also remember: Pixel", status: NO_STORED_STATUS, processedAt: null, awaited: true },
  ],
};

describe("assertDeliveryStatus", () => {
  it("passes when the delivery reached the status", () => {
    expect(() => assertDeliveryStatus(processed, DELIVERY_STATUS.processed)).not.toThrow();
  });

  it.each<{ state: DeliveryState; reached: string }>([
    { state: { status: DELIVERY_STATUS.unobserved }, reached: "never updated" },
    { state: { status: DELIVERY_STATUS.processing }, reached: "still processing" },
    { state: { status: DELIVERY_STATUS.failed, error: "boom", attempts: 2 }, reached: "failed after 2 attempt(s): boom" },
  ])("fails naming the state it reached: $state.status", ({ state, reached }) => {
    expect(() => assertDeliveryStatus(state, DELIVERY_STATUS.processed)).toThrow(`expected delivery status "processed", but it was ${reached}`);
  });

  it("fails when processed was not the expected status", () => {
    expect(() => assertDeliveryStatus(processed, DELIVERY_STATUS.failed)).toThrow("but it was processed at 2026-01-01T00:00:00.000Z");
  });

  it("prefixes the label to the failure", () => {
    expect(() => assertDeliveryStatus({ status: DELIVERY_STATUS.processing }, DELIVERY_STATUS.processed, "round 2")).toThrow(
      'round 2: expected delivery status "processed", but it was still processing',
    );
  });

  it("reports what the platform stored after a stalled wait, marking the awaited message", () => {
    const failure = () => assertDeliveryStatus({ status: DELIVERY_STATUS.unobserved, stalled }, DELIVERY_STATUS.processed);
    expect(failure).toThrow("but it was never updated");
    expect(failure).toThrow("no update in 180000ms (waiting since 2026-01-01T00:00:01.000Z; stored state read at 2026-01-01T00:03:01.000Z)");
    expect(failure).toThrow('- m1 "Remember: teal" status=processing processed_at=none');
    expect(failure).toThrow('* m2 "Also remember: Pixel" status=none processed_at=none');
  });

  it("says so when the stored state could not be read", () => {
    const state: DeliveryState = { status: DELIVERY_STATUS.unobserved, stalled: { ...stalled, stored: undefined } };
    expect(() => assertDeliveryStatus(state, DELIVERY_STATUS.processed)).toThrow("stored state unavailable: the readback failed");
  });
});
