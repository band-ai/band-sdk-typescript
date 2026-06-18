/**
 * Pure mention-resolution for the Band channel.
 *
 * Band requires every chat message to carry at least one @mention. This module
 * resolves the mention list for an outgoing message; it is intentionally PURE
 * (no SDK, no network, no global state) so it is trivially unit-testable. The
 * "throw if this resolves to zero" invariant lives in the outbound adapter, not
 * here — this module simply reports who should be mentioned.
 *
 * Contract (architect consensus, INT-836 C2):
 *  - explicit @Name in the text wins over any fallback
 *  - multiple @Names -> multiple mentions, in participant order
 *  - case-insensitive
 *  - self is never mentioned
 *  - word-boundary match: "@bob" does not match "bobby" and an email-like
 *    "a@bob" is not treated as a mention
 *  - partial names do NOT fire: "@John" does not match a participant named
 *    "John Doe" (intentional — a mention must name the participant in full)
 *  - duplicate participant entries sharing one id yield a single mention
 *  - fallback order: last sender (if a non-self participant) -> first other
 *    participant -> [] (empty)
 */

export interface MentionParticipant {
  id: string;
  name: string;
}

export interface ResolvedMention {
  id: string;
  name: string;
}

export interface LastSender {
  senderId: string;
  senderName: string;
}

/** Escape a participant name for safe inclusion in a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Is `@name` present in `text` as a real mention token?
 *
 * Requires a non-word boundary on both sides of the token so that:
 *  - "@bob" does not match inside "@bobby"
 *  - "a@bob" (email) is not a mention (the char before `@` is a word char)
 */
function mentionPresent(text: string, name: string): boolean {
  const re = new RegExp(`(?<![\\w])@${escapeRegExp(name)}(?![\\w])`, "i");
  return re.test(text);
}

/**
 * Return every participant explicitly @mentioned in `text`, excluding self,
 * preserving participant order.
 */
export function extractExplicitMentions(
  text: string,
  participants: MentionParticipant[],
  selfId: string,
): ResolvedMention[] {
  const matches: ResolvedMention[] = [];
  const seen = new Set<string>();
  for (const p of participants) {
    if (p.id === selfId || seen.has(p.id)) continue;
    if (mentionPresent(text, p.name)) {
      matches.push({ id: p.id, name: p.name });
      seen.add(p.id);
    }
  }
  return matches;
}

/**
 * Resolve the mention list for an outgoing message.
 *
 * Returns an empty array when no recipient can be resolved (e.g. the agent is
 * the only participant); the caller decides how to handle empty (the outbound
 * adapter throws, per the mandatory-mention invariant).
 */
export function resolveMentions(params: {
  participants: MentionParticipant[];
  selfId: string;
  text: string;
  lastSender?: LastSender | null;
}): ResolvedMention[] {
  const { participants, selfId, text, lastSender } = params;

  // 1. Explicit @Name mentions win.
  const explicit = extractExplicitMentions(text, participants, selfId);
  if (explicit.length > 0) return explicit;

  // 2. Fall back to the last sender, if they are a non-self participant.
  if (lastSender) {
    const sender = participants.find(
      (p) => p.id === lastSender.senderId && p.id !== selfId,
    );
    if (sender) return [{ id: sender.id, name: sender.name }];
  }

  // 3. Fall back to the first other participant.
  const other = participants.find((p) => p.id !== selfId);
  return other ? [{ id: other.id, name: other.name }] : [];
}
