import { describe, expect, it } from "vitest";

import type { MessageCreatedPayload } from "../../../src/platform/events";
import { RecordLog } from "../../testUtils";
import { DELIVERY_STATUS, observeAgent, type DeliveryStatus } from "./observeDelivery";
import { MESSAGE_TYPE } from "./observeMessages";

const AGENT = { id: "agent" };
const OTHER = "other-agent";
const SENT = { id: "m1" };

/** A room whose captured `message_updated` frames carry these per-recipient statuses, in order. */
function roomWith(...updates: Array<{ id?: string; recipient?: string; status: DeliveryStatus }>) {
  const deliveryUpdates = new RecordLog<MessageCreatedPayload>();
  for (const { id = SENT.id, recipient = AGENT.id, status } of updates) {
    deliveryUpdates.record({
      id,
      content: "hi",
      message_type: MESSAGE_TYPE.Text,
      sender_id: "user",
      sender_type: "User",
      inserted_at: "",
      updated_at: "",
      metadata: { delivery_status: { [recipient]: { status } } },
    });
  }
  return { deliveryUpdates };
}

describe("observeAgent", () => {
  it("reports the statuses a message passed through, in order, for this agent only", () => {
    const room = roomWith(
      { status: DELIVERY_STATUS.processing },
      { status: DELIVERY_STATUS.processing },
      { recipient: OTHER, status: DELIVERY_STATUS.failed },
      { id: "m2", status: DELIVERY_STATUS.failed },
      { status: DELIVERY_STATUS.processed },
    );
    expect(observeAgent(AGENT, room).history(SENT)).toEqual([DELIVERY_STATUS.processing, DELIVERY_STATUS.processed]);
  });

  it("reads the current status without waiting", () => {
    const room = roomWith({ status: DELIVERY_STATUS.processing }, { status: DELIVERY_STATUS.processed });
    expect(observeAgent(AGENT, room).status(SENT).status).toBe(DELIVERY_STATUS.processed);
  });

  it("is unobserved, with no history, before any update for this agent", () => {
    const room = roomWith({ recipient: OTHER, status: DELIVERY_STATUS.processed });
    const delivery = observeAgent(AGENT, room);
    expect(delivery.status(SENT).status).toBe(DELIVERY_STATUS.unobserved);
    expect(delivery.history(SENT)).toEqual([]);
  });
});
