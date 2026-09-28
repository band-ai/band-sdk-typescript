/**
 * The delivery barrier: wait until an agent has processed a posted message,
 * from the platform's per-recipient delivery state (`message_updated`), never
 * from reply text. Proves the turn finished and its durable state is saved;
 * it does NOT prove the reply frame is captured yet — that is `untilReply`.
 *
 * `failed` is not terminal (the platform retries), so `untilProcessed` holds through it.
 */
import { Band } from "@band-ai/rest-client";

import type { MessageCreatedPayload } from "../../../src/platform/events";
import { LIVE_EVENT_TIMEOUT_MS } from "../../integration/support/liveHarness";
import type { AgentIdentity } from "./agents";
import type { Room, SentMessage } from "./rooms";
import { waitFor } from "./waitFor";

const PLATFORM_STATUS = Band.MessageStatusResponse.Status;

/** The platform's per-recipient statuses, plus `unobserved` before any update arrives. */
export const DELIVERY_STATUS = {
  unobserved: "unobserved",
  processing: PLATFORM_STATUS.Processing,
  processed: PLATFORM_STATUS.Processed,
  failed: PLATFORM_STATUS.Failed,
} as const;

export type DeliveryState =
  /** No delivery update seen yet; the platform never pushes `delivered` on its own. */
  | { status: typeof DELIVERY_STATUS.unobserved }
  | { status: typeof DELIVERY_STATUS.processing }
  | { status: typeof DELIVERY_STATUS.processed; processedAt: Date }
  | { status: typeof DELIVERY_STATUS.failed; error: string; attempts: number };

export type DeliveryStatus = DeliveryState["status"];

interface RecipientDelivery {
  status?: string;
  processed_at?: string | null;
  attempts?: Array<{ error?: string | null }>;
}

function deliveryState(delivery: RecipientDelivery): DeliveryState {
  switch (delivery.status) {
    case DELIVERY_STATUS.processed:
      return { status: DELIVERY_STATUS.processed, processedAt: new Date(delivery.processed_at ?? "") };
    case DELIVERY_STATUS.failed: {
      const attempts = delivery.attempts ?? [];
      return { status: DELIVERY_STATUS.failed, error: attempts.at(-1)?.error ?? "unknown error", attempts: attempts.length };
    }
    default:
      return { status: DELIVERY_STATUS.processing };
  }
}

/** The latest delivery state of `messageId` for `recipientId` among the captured updates. */
function latestState(updates: readonly MessageCreatedPayload[], messageId: string, recipientId: string): DeliveryState {
  const latest = updates
    .filter((update) => update.id === messageId)
    .map((update) => (update.metadata?.delivery_status as Record<string, RecipientDelivery> | undefined)?.[recipientId])
    .filter((delivery) => delivery !== undefined)
    .at(-1);
  return latest ? deliveryState(latest) : { status: DELIVERY_STATUS.unobserved };
}

export function observeAgent(agent: AgentIdentity, room: Room) {
  /** The state `message` reached for this agent: `status`, or the last one seen when the wait timed out. */
  const untilStatus = async (
    message: SentMessage,
    status: DeliveryStatus,
    timeoutMs = LIVE_EVENT_TIMEOUT_MS,
  ): Promise<DeliveryState> => {
    const current = () => latestState(room.deliveryUpdates.entries, message.id, agent.id);
    const reached = await waitFor(
      room.deliveryUpdates,
      () => {
        const state = current();
        return state.status === status ? state : undefined;
      },
      timeoutMs,
    );
    return reached ?? current();
  };

  return {
    untilStatus,
    /** The common barrier: the turn finished and its durable state is saved. */
    untilProcessed: (message: SentMessage, timeoutMs?: number) => untilStatus(message, DELIVERY_STATUS.processed, timeoutMs),
  };
}
