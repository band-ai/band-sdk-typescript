import { afterEach, describe, expect, it, vi } from "vitest";

import type { MessageCreatedPayload } from "../../../src/platform/events";
import { RecordLog } from "../../testUtils";
import { DELIVERY_STATUS, NO_STORED_STATUS, observeAgent, type DeliveryStatus } from "./observeDelivery";
import { MESSAGE_TYPE, type CapturedMessage } from "./observeMessages";

const AGENT = { id: "agent" };
const OTHER = "other-agent";
const SENT = { id: "m1" };
const ROOM_ID = "room";
const SHORT_WAIT_MS = 20;

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
  return { id: ROOM_ID, deliveryUpdates };
}

/** A stored text message as the REST readback returns it, with these per-recipient delivery entries. */
function stored(
  id: string,
  content: string,
  deliveryStatus?: Record<string, { status: string; processed_at?: string }>,
  senderId = "user",
): CapturedMessage {
  return { id, content, senderId, messageType: MESSAGE_TYPE.Text, mentionIds: [], metadata: deliveryStatus ? { delivery_status: deliveryStatus } : {} };
}

describe("observeAgent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  describe("a wait that times out", () => {
    it("returns the state it saw with what the platform stored for this agent, every message it did not send", async () => {
      const room = roomWith({ id: "m2", status: DELIVERY_STATUS.processing });
      const readback = [
        stored("m1", "Remember: my favorite color is teal.", { [AGENT.id]: { status: DELIVERY_STATUS.processing } }),
        stored("m2", "Also remember: my dog is named Pixel and that is a long line of text"),
        stored("m3", "Earlier", { [OTHER]: { status: DELIVERY_STATUS.failed }, [AGENT.id]: { status: DELIVERY_STATUS.processed, processed_at: "2026-01-01T00:00:05Z" } }),
        stored("reply", "Noted.", undefined, AGENT.id),
      ];

      const state = await observeAgent(AGENT, room, async () => readback).untilProcessed({ id: "m2" }, SHORT_WAIT_MS);

      expect(state.status).toBe(DELIVERY_STATUS.processing);
      expect(state.stalled?.waitedMs).toBe(SHORT_WAIT_MS);
      expect(state.stalled?.stored).toEqual([
        { id: "m1", contentPrefix: "Remember: my favorite color is teal.", status: DELIVERY_STATUS.processing, processedAt: null, awaited: false },
        { id: "m2", contentPrefix: "Also remember: my dog is named Pixel and", status: NO_STORED_STATUS, processedAt: null, awaited: true },
        { id: "m3", contentPrefix: "Earlier", status: DELIVERY_STATUS.processed, processedAt: "2026-01-01T00:00:05Z", awaited: false },
      ]);
    });

    it("reads the room the wait was on", async () => {
      const readRooms: string[] = [];
      await observeAgent(AGENT, roomWith(), async ({ id }) => {
        readRooms.push(id);
        return [];
      }).untilProcessed(SENT, SHORT_WAIT_MS);
      expect(readRooms).toEqual([ROOM_ID]);
    });

    it("keeps the timeout when the readback fails", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const state = await observeAgent(AGENT, roomWith(), async () => {
        throw new Error("platform unreachable");
      }).untilProcessed(SENT, SHORT_WAIT_MS);

      expect(state.status).toBe(DELIVERY_STATUS.unobserved);
      expect(state.stalled?.stored).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(ROOM_ID), expect.objectContaining({ message: "platform unreachable" }));
    });
  });

  it("returns the reached state without reading the platform back", async () => {
    const room = roomWith({ status: DELIVERY_STATUS.processed });
    const readMessages = vi.fn(async () => []);

    const state = await observeAgent(AGENT, room, readMessages).untilProcessed(SENT, SHORT_WAIT_MS);

    expect(state.status).toBe(DELIVERY_STATUS.processed);
    expect(state.stalled).toBeUndefined();
    expect(readMessages).not.toHaveBeenCalled();
  });
});
