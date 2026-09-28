import { describe, expect, it } from "vitest";

import { assertDeliveryStatus } from "./assertDelivery";
import { DELIVERY_STATUS, type DeliveryState } from "./observeDelivery";

const processed: DeliveryState = { status: DELIVERY_STATUS.processed, processedAt: new Date("2026-01-01T00:00:00Z") };

describe("assertDeliveryStatus", () => {
  it("passes when the delivery reached the status", () => {
    expect(() => assertDeliveryStatus(processed, DELIVERY_STATUS.processed)).not.toThrow();
  });

  it.each<{ state: DeliveryState; reached: string }>([
    { state: { status: DELIVERY_STATUS.unobserved }, reached: "no delivery update was observed" },
    { state: { status: DELIVERY_STATUS.processing }, reached: "still processing" },
    { state: { status: DELIVERY_STATUS.failed, error: "boom", attempts: 2 }, reached: "failed after 2 attempt(s): boom" },
  ])("fails naming the state it reached: $state.status", ({ state, reached }) => {
    expect(() => assertDeliveryStatus(state, DELIVERY_STATUS.processed)).toThrow(`expected delivery status "processed", but it was ${reached}`);
  });

  it("fails when processed was not the expected status", () => {
    expect(() => assertDeliveryStatus(processed, DELIVERY_STATUS.failed)).toThrow("but it was processed at 2026-01-01T00:00:00.000Z");
  });
});
