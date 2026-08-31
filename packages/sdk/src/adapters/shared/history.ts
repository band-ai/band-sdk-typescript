import { asOptionalRecord } from "./coercion";

export function findLatestTaskMetadata(
  raw: Array<Record<string, unknown>>,
  predicate: (metadata: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  for (let index = raw.length - 1; index >= 0; index -= 1) {
    const message = raw[index] ?? {};
    const messageType = String(message.message_type ?? message.messageType ?? "");
    if (messageType !== "task") {
      continue;
    }

    const metadata = asOptionalRecord(message.metadata) ?? {};
    if (predicate(metadata)) {
      return metadata;
    }
  }

  return null;
}

/**
 * The minimal shape `selectCompleteExchanges` needs from an adapter's
 * message type.  Adapters keep their own richer types (sender, senderType,
 * …); the generic parameter preserves them through the call.
 */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Merge consecutive same-role messages, then keep paired user→assistant
 * exchanges and an optional trailing user message.  Merging first
 * ensures that consecutive user messages (common in multi-participant
 * conversations) are preserved rather than silently dropped.  Orphaned
 * assistant messages without a preceding user turn are still dropped so
 * that the agent receives a clean alternating conversation.
 *
 * The input is never mutated: merged entries are shallow copies.
 *
 * `limit` caps how many turns come back, keeping the most recent ones.
 * Truncation happens here rather than at the call site because a raw
 * `slice(-limit)` can land mid-exchange and reintroduce the orphaned
 * assistant turn this function exists to remove.
 */
export function selectCompleteExchanges<T extends ChatTurn>(
  history: T[],
  limit?: number,
): T[] {
  // 1. Merge consecutive same-role messages into single entries so no
  //    user content is lost when multiple participants speak in a row.
  const merged: T[] = [];
  for (const msg of history) {
    if (!msg.content) continue;
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role) {
      prev.content += `\n${msg.content}`;
    } else {
      merged.push({ ...msg });
    }
  }

  // 2. Select user→assistant pairs + optional trailing user message.
  const complete: T[] = [];

  let index = 0;
  while (index < merged.length) {
    const current = merged[index];

    if (current.role === "user" && current.content) {
      const next = merged[index + 1];
      if (next && next.role === "assistant" && next.content) {
        complete.push(current);
        complete.push(next);
        index += 2;
        continue;
      }

      // Include a trailing user message (no assistant reply yet) so the
      // agent has context about the most recent unanswered question.
      if (index === merged.length - 1) {
        complete.push(current);
      }

      index += 1;
      continue;
    }

    // Skip orphaned assistant messages without a preceding user message.
    index += 1;
  }

  if (limit === undefined || complete.length <= limit) {
    return complete;
  }

  const truncated = complete.slice(-limit);
  if (truncated[0]?.role === "assistant") {
    // The cut landed between a user turn and its reply; drop the reply so
    // the agent never sees an answer whose question was truncated away.
    truncated.shift();
  }

  return truncated;
}
