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
 * The minimal shape the history helpers need from an adapter's message
 * type.  Adapters keep their own richer types (sender, senderType, ...);
 * the generic parameter preserves them through each call.
 */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Join runs of same-role messages into a single entry so that nothing is
 * lost when several participants speak before the agent replies.  Entries
 * are shallow copies, so the input is never mutated.
 */
function mergeConsecutiveSameRole<T extends ChatTurn>(history: readonly T[]): T[] {
  const merged: T[] = [];

  for (const message of history) {
    if (!message.content) {
      continue;
    }

    const previous = merged[merged.length - 1];
    if (previous && previous.role === message.role) {
      previous.content += `\n${message.content}`;
    } else {
      merged.push({ ...message });
    }
  }

  return merged;
}

/**
 * Keep user->assistant pairs, plus a trailing user message that has no
 * reply yet so the agent sees the most recent unanswered question.
 * Assistant turns with no preceding question are dropped, leaving a clean
 * alternating conversation.
 */
function pairUserAssistantTurns<T extends ChatTurn>(turns: readonly T[]): T[] {
  const paired: T[] = [];
  let index = 0;

  while (index < turns.length) {
    const current = turns[index];
    if (current.role !== "user" || !current.content) {
      index += 1;
      continue;
    }

    const next = turns[index + 1];
    if (next && next.role === "assistant" && next.content) {
      paired.push(current, next);
      index += 2;
      continue;
    }

    if (index === turns.length - 1) {
      paired.push(current);
    }

    index += 1;
  }

  return paired;
}

/**
 * Keep the most recent `limit` turns.  A plain `slice(-limit)` can land
 * between a question and its answer, so an assistant turn left leading by
 * the cut is dropped rather than replayed without the question it answers.
 */
function takeRecentWholeExchanges<T extends ChatTurn>(
  turns: T[],
  limit: number,
): T[] {
  if (turns.length <= limit) {
    return turns;
  }

  const truncated = turns.slice(-limit);
  if (truncated[0]?.role === "assistant") {
    truncated.shift();
  }

  return truncated;
}

/**
 * Select the conversation history to replay to an agent: consecutive
 * same-role messages are merged rather than dropped, complete
 * user->assistant exchanges are kept in order, and a trailing unanswered
 * user message is preserved.
 *
 * `limit` caps how many turns come back, keeping the most recent.  It
 * belongs here rather than at the call site because truncating afterwards
 * can cut between a question and its answer.
 *
 * The input is never mutated.
 */
export function selectCompleteExchanges<T extends ChatTurn>(
  history: readonly T[],
  limit?: number,
): T[] {
  const exchanges = pairUserAssistantTurns(mergeConsecutiveSameRole(history));

  return limit === undefined
    ? exchanges
    : takeRecentWholeExchanges(exchanges, limit);
}
