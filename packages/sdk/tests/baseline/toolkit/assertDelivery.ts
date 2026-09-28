/** Assertions on a message's delivery state for one recipient. */
import type { DeliveryState } from "./observeDelivery";

function describeState(state: DeliveryState): string {
  switch (state.status) {
    case "unobserved":
      return "no delivery update was observed";
    case "processing":
      return "still processing";
    case "processed":
      return `processed at ${state.processedAt.toISOString()}`;
    case "failed":
      return `failed after ${state.attempts} attempt(s): ${state.error}`;
    default: {
      const unhandled: never = state;
      return String(unhandled);
    }
  }
}

/** Fails unless the delivery reached `status`, naming the state it did reach. */
export function assertDeliveryStatus<S extends DeliveryState["status"]>(
  state: DeliveryState,
  status: S,
): asserts state is Extract<DeliveryState, { status: S }> {
  if (state.status !== status) {
    throw new Error(`expected delivery status "${status}", but it was ${describeState(state)}`);
  }
}
