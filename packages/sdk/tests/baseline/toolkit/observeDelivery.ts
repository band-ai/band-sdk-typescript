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
import { history, MESSAGE_TYPE, type CapturedMessage } from "./observeMessages";
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

/** What a stored message shows for a recipient that has no delivery entry for it: the platform never wrote one. */
export const NO_STORED_STATUS = "none";

/** Characters of a stored message's content a stalled-wait report keeps, enough to tell rounds apart. */
const STORED_CONTENT_PREFIX_LENGTH = 40;

/** One message as the platform stores it, for the recipient a stalled wait was on. */
export interface StoredDelivery {
  id: string;
  contentPrefix: string;
  /** The platform's own status for the recipient, unfolded, or `NO_STORED_STATUS`. */
  status: string;
  processedAt: string | null;
  /** The message the wait was on. */
  awaited: boolean;
}

/** What a timed-out wait knows beyond the frames it saw: the platform's stored state, read once the wait gave up. */
export interface StalledWait {
  waitedMs: number;
  waitStartedAt: Date;
  readAt: Date;
  /** Every text message not sent by the recipient, oldest first; `undefined` when the readback failed. */
  stored: StoredDelivery[] | undefined;
}

export type DeliveryState = (
  /** No delivery update seen yet; the platform never pushes `delivered` on its own. */
  | { status: typeof DELIVERY_STATUS.unobserved }
  | { status: typeof DELIVERY_STATUS.processing }
  | { status: typeof DELIVERY_STATUS.processed; processedAt: Date }
  | { status: typeof DELIVERY_STATUS.failed; error: string; attempts: number }
) & {
  /** Set only on the state a timed-out wait returns. */
  stalled?: StalledWait;
};

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

/** Every delivery state of `messageId` for `recipientId` among the captured updates, in arrival order. */
function statesOf(updates: readonly MessageCreatedPayload[], messageId: string, recipientId: string): DeliveryState[] {
  return updates
    .filter((update) => update.id === messageId)
    .map((update) => (update.metadata?.delivery_status as Record<string, RecipientDelivery> | undefined)?.[recipientId])
    .filter((delivery) => delivery !== undefined)
    .map(deliveryState);
}

/** The recipient's view of every message it did not send: a missing entry is what a message that was never marked looks like. */
function storedDeliveries(stored: readonly CapturedMessage[], recipientId: string, awaitedId: string): StoredDelivery[] {
  return stored
    .filter((message) => message.senderId !== recipientId)
    .map((message) => {
      const delivery = (message.metadata.delivery_status as Record<string, RecipientDelivery> | undefined)?.[recipientId];
      return {
        id: message.id,
        contentPrefix: message.content.slice(0, STORED_CONTENT_PREFIX_LENGTH),
        status: delivery?.status ?? NO_STORED_STATUS,
        processedAt: delivery?.processed_at ?? null,
        awaited: message.id === awaitedId,
      };
    });
}

/**
 * `readMessages` is the live REST fetch of the room's stored text messages, the
 * only part a unit test replaces.
 */
export function observeAgent(
  agent: Pick<AgentIdentity, "id">,
  room: Pick<Room, "id" | "deliveryUpdates">,
  readMessages: (room: Pick<Room, "id">) => Promise<CapturedMessage[]> = (target) => history(target, MESSAGE_TYPE.Text),
) {
  const states = (message: SentMessage) => statesOf(room.deliveryUpdates.entries, message.id, agent.id);
  /** The state `message` is in now, from the updates already captured; never waits. */
  const current = (message: SentMessage): DeliveryState => states(message).at(-1) ?? { status: DELIVERY_STATUS.unobserved };

  /** Reads the platform's stored state after a wait gave up; a failed read must not mask the timeout. */
  const stalledWait = async (message: SentMessage, waitedMs: number, waitStartedAt: Date): Promise<StalledWait> => {
    try {
      const stored = storedDeliveries(await readMessages(room), agent.id, message.id);
      return { waitedMs, waitStartedAt, readAt: new Date(), stored };
    } catch (error) {
      console.warn(`baseline: could not read back room ${room.id} after a stalled delivery wait:`, error);
      return { waitedMs, waitStartedAt, readAt: new Date(), stored: undefined };
    }
  };

  /**
   * The state `message` reached for this agent: `status`, or the last one seen
   * when the wait timed out, carrying the platform's stored state as `stalled`.
   */
  const untilStatus = async (
    message: SentMessage,
    status: DeliveryStatus,
    timeoutMs = LIVE_EVENT_TIMEOUT_MS,
  ): Promise<DeliveryState> => {
    const waitStartedAt = new Date();
    const reached = await waitFor(
      room.deliveryUpdates,
      () => {
        const state = current(message);
        return state.status === status ? state : undefined;
      },
      timeoutMs,
    );
    return reached ?? { ...current(message), stalled: await stalledWait(message, timeoutMs, waitStartedAt) };
  };

  return {
    status: current,
    /** The statuses `message` passed through for this agent, in order, each repeat collapsed. */
    history: (message: SentMessage): DeliveryStatus[] =>
      states(message)
        .map((state) => state.status)
        .filter((status, index, all) => status !== all[index - 1]),
    untilStatus,
    /** The common barrier: the turn finished and its durable state is saved. */
    untilProcessed: (message: SentMessage, timeoutMs?: number) => untilStatus(message, DELIVERY_STATUS.processed, timeoutMs),
  };
}
