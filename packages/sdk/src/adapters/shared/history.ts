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
 * type.  Adapters extend it with their own fields; the generic parameter
 * preserves those through each call.  `sender` is optional here but both
 * `LettaMessage` and `ParlantMessage` always set it — it identifies which
 * participant (or, on the assistant side, which bot) spoke the turn.
 */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  sender?: string;
}

/**
 * Join runs of same-role messages into a single turn so that nothing is
 * lost when several participants speak before the agent replies.
 *
 * Assistant turns only merge when they share the same `sender`: adapters
 * inject the merged turn's history entry under a single display name
 * (`item.sender`), so folding two different bots' replies together would
 * silently relabel the second bot's words as the first bot's. User turns
 * merge regardless of sender — the injected history has no per-user
 * attribution to lose.
 *
 * `adapters/tool-calling/valueUtils.ts` has a same-purpose
 * `mergeConsecutiveSameRole` for a different data shape: it folds raw
 * wire-format API messages (`content` may be a string or a content-block
 * array, no `sender`) rather than typed `ChatTurn`s, which is why it isn't
 * reused here.
 */
function mergeConsecutiveSameRoleTurns<T extends ChatTurn>(turns: readonly T[]): T[] {
  const merged: T[] = [];

  for (const turn of turns) {
    if (!turn.content) {
      continue;
    }

    const previous = merged[merged.length - 1];
    const canMerge =
      previous !== undefined &&
      previous.role === turn.role &&
      (turn.role !== "assistant" || previous.sender === turn.sender);

    if (canMerge) {
      previous.content += `\n${turn.content}`;
    } else {
      merged.push({ ...turn });
    }
  }

  return merged;
}

/**
 * Keep user->assistant(s) groups, plus a trailing user turn that has no
 * reply yet so the agent sees the most recent unanswered question.
 * Assistant turns with no preceding question are dropped, leaving a clean
 * alternating conversation.
 *
 * A user turn can be followed by more than one assistant turn: same-sender
 * assistant runs are already merged by `mergeConsecutiveSameRoleTurns`, but
 * a run from *different* senders (several bots replying to the same
 * question) is deliberately left as separate turns so each keeps its own
 * identity, and every one of them is kept here — not just the first.
 */
function pairUserAssistantTurns<T extends ChatTurn>(turns: readonly T[]): T[] {
  const paired: T[] = [];
  let index = 0;

  while (index < turns.length) {
    const current = turns[index];
    if (current.role !== "user") {
      index += 1;
      continue;
    }

    paired.push(current);
    index += 1;

    while (index < turns.length && turns[index].role === "assistant") {
      paired.push(turns[index]);
      index += 1;
    }
  }

  return paired;
}

/**
 * Keep the most recent `limit` turns.  A plain `slice(-limit)` can land
 * between a question and its answer, so any assistant turn(s) left leading
 * by the cut are dropped rather than replayed without the question they
 * answer — a user turn can be followed by more than one assistant turn
 * (different bots replying to the same question), so this strips the
 * *whole* leading run, not just its first entry, which is why the result
 * can be more than one turn shorter than `limit`.
 *
 * `limit <= 0` returns no history at all. The pre-existing call sites used
 * `.slice(-maxHistoryMessages)` directly, where `slice(-0)` is `slice(0)`
 * and returns the *whole* array — an accident of `-0 === 0`, not a
 * documented "0 means unlimited" contract. Treating 0 as "inject nothing"
 * is the behavior actually implied by the option's name.
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
  while (truncated[0]?.role === "assistant") {
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
    pairUserAssistantTurns(mergeConsecutiveSameRoleTurns(history)),
    limit,
  );
}
