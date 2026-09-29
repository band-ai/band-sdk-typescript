/** Assertions on a message's delivery state for one recipient. */
import { DELIVERY_STATUS, type DeliveryState, type DeliveryStatus, type StalledWait, type StoredDelivery } from "./observeDelivery";

function describeStatus(state: DeliveryState): string {
  switch (state.status) {
    case DELIVERY_STATUS.unobserved:
      return "never updated";
    case DELIVERY_STATUS.processing:
      return "still processing";
    case DELIVERY_STATUS.processed:
      return `processed at ${state.processedAt.toISOString()}`;
    case DELIVERY_STATUS.failed:
      return `failed after ${state.attempts} attempt(s): ${state.error}`;
    default: {
      const unhandled: never = state;
      return String(unhandled);
    }
  }
}

function describeStored({ id, contentPrefix, status, processedAt, awaited }: StoredDelivery): string {
  return `  ${awaited ? "*" : "-"} ${id} ${JSON.stringify(contentPrefix)} status=${status} processed_at=${processedAt ?? "none"}`;
}

/** What the platform stored when a wait gave up, so a missing update reads as an agent stall or a missed frame. */
function describeStalled({ waitedMs, waitStartedAt, readAt, stored }: StalledWait): string {
  const timing = `no update in ${waitedMs}ms (waiting since ${waitStartedAt.toISOString()}; stored state read at ${readAt.toISOString()})`;
  const readback = stored
    ? ["stored messages not sent by the agent, oldest first (* is the awaited one):", ...stored.map(describeStored)].join("\n")
    : "stored state unavailable: the readback failed";
  return `${timing}\n${readback}`;
}

function describeState(state: DeliveryState): string {
  return state.stalled ? `${describeStatus(state)}\n${describeStalled(state.stalled)}` : describeStatus(state);
}

/** Fails unless the delivery reached `status`, naming the state it did reach; `label` says which check failed. */
export function assertDeliveryStatus<S extends DeliveryStatus>(
  state: DeliveryState,
  status: S,
  label?: string,
): asserts state is Extract<DeliveryState, { status: S }> {
  if (state.status !== status) {
    const prefix = label ? `${label}: ` : "";
    throw new Error(`${prefix}expected delivery status "${status}", but it was ${describeState(state)}`);
  }
}
