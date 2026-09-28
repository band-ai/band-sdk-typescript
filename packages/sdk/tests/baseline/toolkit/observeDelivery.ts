/**
 * The delivery barrier: wait until an agent has processed a posted message,
 * from the platform's per-recipient delivery state (`message_updated`), never
 * from reply text. Proves the turn finished and its durable state is saved;
 * it does NOT prove the reply frame is captured yet — that is `untilReply`.
 *
 * `FAILED` is not terminal (the platform retries), so the wait holds through it.
 */
import type { MessageCreatedPayload } from "../../../src/platform/events";
import { LIVE_EVENT_TIMEOUT_MS } from "../../integration/support/liveHarness";
import type { AgentIdentity } from "./agents";
import type { Room, SentMessage } from "./rooms";
import { waitFor } from "./waitFor";

export type DeliveryState =
  /** No delivery update seen yet; the platform never pushes `delivered` on its own. */
  | { status: "unobserved" }
  | { status: "processing" }
  | { status: "processed"; processedAt: Date }
  | { status: "failed"; error: string; attempts: number };

interface RecipientDelivery {
  status?: string;
  processed_at?: string | null;
  attempts?: Array<{ error?: string | null }>;
}

function deliveryState(delivery: RecipientDelivery): DeliveryState {
  switch (delivery.status) {
    case "processed":
      return { status: "processed", processedAt: new Date(delivery.processed_at ?? "") };
    case "failed": {
      const attempts = delivery.attempts ?? [];
      return { status: "failed", error: attempts.at(-1)?.error ?? "unknown error", attempts: attempts.length };
    }
    default:
      return { status: "processing" };
  }
}

/** The latest delivery state of `messageId` for `recipientId` among the captured updates. */
function latestState(updates: readonly MessageCreatedPayload[], messageId: string, recipientId: string): DeliveryState {
  const latest = updates
    .filter((update) => update.id === messageId)
    .map((update) => (update.metadata?.delivery_status as Record<string, RecipientDelivery> | undefined)?.[recipientId])
    .filter((delivery) => delivery !== undefined)
    .at(-1);
  return latest ? deliveryState(latest) : { status: "unobserved" };
}

export function observeAgent(agent: AgentIdentity, room: Room) {
  return {
    /** The state `message` reached for this agent: `processed`, or the last one seen when the wait timed out. */
    async untilProcessed(message: SentMessage, timeoutMs = LIVE_EVENT_TIMEOUT_MS): Promise<DeliveryState> {
      const current = () => latestState(room.deliveryUpdates.entries, message.id, agent.id);
      const processed = await waitFor(
        room.deliveryUpdates,
        () => (current().status === "processed" ? current() : undefined),
        timeoutMs,
      );
      return processed ?? current();
    },
  };
}
