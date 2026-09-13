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
 * type.  Adapters extend it with their own fields (sender, senderType,
 * ...); the generic parameter preserves those through each call.
 */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  /**
   * Display name of whoever produced the turn.  Optional so a caller with no
   * notion of per-turn identity still satisfies the constraint; both adapter
   * message types supply it.
   */
  sender?: string;
}

/**
 * Join runs of same-role messages into a single turn so that nothing is
 * lost when several participants speak before the agent replies.
 *
 * A run can span several speakers, and the merged turn carries only one
 * identity downstream: `LettaAdapter` prefixes the whole block with
 * `item.sender`, `ParlantAdapter` sends it under one participant's
 * `displayName`.  A later speaker's name therefore has to travel inside the
 * text, or their message is replayed under the wrong name.  Assistant turns
 * get that `[name]: ` prefix here; user turns already carry one from the
 * history converters, which would double it.
 *
 * Not the same operation as `mergeConsecutiveSameRole` in
 * `adapters/tool-calling/valueUtils.ts`: that one rewrites provider wire
 * messages to satisfy an alternating-role API constraint, joins with a blank
 * line, and never touches identity.  Same name, different layer.
 */
function mergeConsecutiveSameRole<T extends ChatTurn>(turns: readonly T[]): T[] {
  const merged: T[] = [];

  for (const turn of turns) {
    if (!turn.content) {
      continue;
    }

    const previous = merged[merged.length - 1];
    if (previous && previous.role === turn.role) {
      previous.content += `\n${contributionOf(turn, previous)}`;
    } else {
      merged.push({ ...turn });
    }
  }

  return merged;
}

/**
 * The text `turn` contributes when folded into the block led by `blockLead`,
 * named when it is a different assistant than the one the block is
 * attributed to.
 */
function contributionOf(turn: ChatTurn, blockLead: ChatTurn): string {
  const speakerChanged =
    turn.role === "assistant" &&
    !!turn.sender &&
    turn.sender !== blockLead.sender;

  return speakerChanged ? `[${turn.sender}]: ${turn.content}` : turn.content;
}

/**
 * Keep user->assistant pairs, plus a trailing user turn that has no reply
 * yet so the agent sees the most recent unanswered question.  Assistant
 * turns with no preceding question are dropped, leaving a clean
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
 * the cut is dropped rather than replayed without the question it answers
 * — which is why the result can be one turn shorter than `limit`.
 *
 * A `limit` of `0` or less selects nothing, reading the option as the cap it
 * is named for.  The call site this replaced ended in `.slice(-limit)`, where
 * `-0 === 0` made `slice(0)` return the whole history — so `0` used to mean
 * "everything" and a negative meant "drop that many from the front".  Both
 * were artefacts of the expression rather than anything chosen, and neither
 * is a reading of `maxHistoryMessages` a caller could arrive at on purpose.
 */
function takeRecentTurns<T extends ChatTurn>(
  turns: readonly T[],
  limit: number,
): T[] {
  if (limit <= 0) {
    return [];
  }

  if (turns.length <= limit) {
    return [...turns];
  }

  const truncated = turns.slice(-limit);
  if (truncated[0]?.role === "assistant") {
    truncated.shift();
  }

  return truncated;
}

/**
 * Select the conversation history to replay to an agent, keeping at most
 * `limit` turns: consecutive same-role messages are merged rather than
 * dropped, complete user->assistant exchanges are kept in order, and a
 * trailing unanswered user message is preserved.
 *
 * Truncation belongs here rather than at the call site because cutting the
 * result afterwards can land between a question and its answer.
 *
 * The input is never mutated; every returned turn is a fresh object.
 */
export function selectCompleteExchanges<T extends ChatTurn>(
  history: readonly T[],
  limit: number,
): T[] {
  return takeRecentTurns(
    pairUserAssistantTurns(mergeConsecutiveSameRole(history)),
    limit,
  );
}
