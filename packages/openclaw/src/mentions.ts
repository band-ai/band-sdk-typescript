/**
 * Pure mention-resolution + formatting for the Band channel.
 *
 * Band's native mention wire-format is the `@[[<participant-uuid>]]` token, and
 * `createChatMessage` only delivers a real notification for entries in its
 * `mentions` array (tokens left in the body render as inert text). So this module
 * is the single place that turns the model's reply text into that array.
 *
 * It mirrors the @thenvoi/sdk resolver (`AgentTools.resolveMentions`):
 *  - a mention resolves by **id -> handle -> name** (the SDK's precedence), so the
 *    model can address someone with the authoritative `@[[uuid]]` token, a
 *    `@handle`, or a display name — whichever it has.
 *  - an explicit mention WINS over the last-sender fallback (an explicit attempt
 *    is never silently rerouted).
 *  - a deliberate `@[[uuid]]` to someone who is NOT a room participant THROWS
 *    rather than falling back to the last sender — the misroute that this module
 *    used to produce (it would ping the owner instead). The throw-on-empty for
 *    the agent-only room still lives in the outbound adapter.
 *  - the last-sender / first-other fallback applies ONLY when the reply carries
 *    no explicit mention at all (the documented plain-text-reply UX).
 *
 * It also provides the inbound-display helpers (`replaceUuidMentions`,
 * `buildParticipantsBlock`) that rewrite `@[[uuid]]` -> `@handle` and inject a
 * participant roster, so the model reads and writes handles instead of raw uuids.
 *
 * The module is intentionally PURE (no SDK, no network, no global state) so it is
 * trivially unit-testable.
 */

export interface MentionParticipant {
  id: string;
  name: string;
  handle?: string | null;
}

export interface ResolvedMention {
  id: string;
  name: string;
  handle?: string;
}

export interface LastSender {
  senderId: string;
  senderName: string;
}

/** Escape a participant name for safe inclusion in a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Normalize a handle for comparison: drop a leading `@`, trim, lowercase. */
function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@+/, "").toLowerCase();
}

/** Band's native id-mention token, e.g. `@[[3d5bd75e-…]]`. */
const UUID_MENTION_PATTERN = "@\\[\\[([0-9a-fA-F-]{36})\\]\\]";
/**
 * A `@handle` token: a username (lowercase letters/digits and `. _ -`) with an
 * optional `/agent-name` segment, e.g. `@john` or `@john/weather-agent`. The
 * leading non-word boundary keeps an email-like `a@bob` from counting as a
 * mention (same contract as the display-name matcher).
 */
const HANDLE_MENTION_PATTERN = "(?<![\\w])@([A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9._-]+)?)";

/**
 * Is `@name` present in `text` as a real mention token? Requires a non-word
 * boundary on both sides so `@bob` does not match inside `@bobby` and `a@bob`
 * (an email) is not a mention.
 */
function mentionPresent(text: string, name: string): boolean {
  const re = new RegExp(`(?<![\\w])@${escapeRegExp(name)}(?![\\w])`, "i");
  return re.test(text);
}

interface ParticipantMaps {
  byId: Map<string, MentionParticipant>;
  byHandle: Map<string, MentionParticipant>;
  byName: Map<string, MentionParticipant>;
}

/** Build id/handle/name lookup maps over the non-self participants. */
function buildMaps(participants: MentionParticipant[], selfId: string): ParticipantMaps {
  const byId = new Map<string, MentionParticipant>();
  const byHandle = new Map<string, MentionParticipant>();
  const byName = new Map<string, MentionParticipant>();
  for (const p of participants) {
    if (p.id === selfId) continue;
    byId.set(p.id, p);
    if (typeof p.handle === "string" && p.handle.trim().length > 0) {
      byHandle.set(normalizeHandle(p.handle), p);
    }
    if (p.name && p.name.trim().length > 0) {
      byName.set(p.name.trim().toLowerCase(), p);
    }
  }
  return { byId, byHandle, byName };
}

function toResolved(p: MentionParticipant): ResolvedMention {
  return { id: p.id, name: p.name, handle: p.handle ?? undefined };
}

/**
 * Return every participant explicitly mentioned in `text`, resolving each token
 * by id (`@[[uuid]]`) -> handle (`@handle`) -> display name (`@Full Name`),
 * excluding self, de-duplicated by id, in first-seen order.
 */
export function extractExplicitMentions(
  text: string,
  participants: MentionParticipant[],
  selfId: string,
): ResolvedMention[] {
  if (!text) return [];
  const { byId, byHandle, byName } = buildMaps(participants, selfId);
  const matches: ResolvedMention[] = [];
  const seen = new Set<string>();
  const push = (p: MentionParticipant) => {
    if (seen.has(p.id)) return;
    seen.add(p.id);
    matches.push(toResolved(p));
  };

  // 1. Authoritative `@[[uuid]]` id tokens (Band's native wire-format).
  for (const m of text.matchAll(new RegExp(UUID_MENTION_PATTERN, "g"))) {
    const id = m[1];
    if (!id) continue;
    const p = byId.get(id);
    if (p) push(p);
  }

  // 2. `@handle` / single-word `@name` tokens (id tokens stripped so they don't
  //    re-match as handles).
  const withoutIds = text.replace(new RegExp(UUID_MENTION_PATTERN, "g"), " ");
  for (const m of withoutIds.matchAll(new RegExp(HANDLE_MENTION_PATTERN, "gi"))) {
    const raw = m[1];
    if (!raw) continue;
    const norm = normalizeHandle(raw);
    const p = byHandle.get(norm) ?? byName.get(norm);
    if (p) push(p);
  }

  // 3. Display-name tokens (`@Full Name`, accented names) the handle scan can't
  //    catch — the word-boundary check keeps an email-like `a@bob` from matching.
  for (const p of participants) {
    if (p.id === selfId || seen.has(p.id)) continue;
    if (p.name && mentionPresent(text, p.name)) push(p);
  }

  return matches;
}

/**
 * `@[[uuid]]` id tokens in `text` that match no current participant (excluding
 * self). A non-empty result means the model deliberately addressed someone who
 * is not in the room — the caller surfaces that instead of misrouting.
 */
export function findUnresolvedMentionIds(
  text: string,
  participants: MentionParticipant[],
  selfId: string,
): string[] {
  if (!text) return [];
  const ids = new Set(participants.map((p) => p.id));
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(new RegExp(UUID_MENTION_PATTERN, "g"))) {
    const id = m[1];
    if (!id || id === selfId || ids.has(id) || seen.has(id)) continue;
    seen.add(id);
    unresolved.push(id);
  }
  return unresolved;
}

/**
 * Resolve the mention list for an outgoing message.
 *
 * Explicit mentions win. If the reply has none but deliberately `@[[uuid]]`-ed a
 * non-participant, throw (don't reroute to the last sender). Otherwise fall back
 * to the last sender, then the first other participant, then `[]` (the outbound
 * adapter enforces the mandatory-mention invariant on empty).
 */
export function resolveMentions(params: {
  participants: MentionParticipant[];
  selfId: string;
  text: string;
  lastSender?: LastSender | null;
}): ResolvedMention[] {
  const { participants, selfId, text, lastSender } = params;

  // 1. Explicit @mentions (id / handle / name) win.
  const explicit = extractExplicitMentions(text, participants, selfId);
  if (explicit.length > 0) return explicit;

  // 2. A deliberate id-mention to a non-participant must NOT be silently
  //    rerouted to the last sender — surface it so the agent learns it failed.
  const unresolved = findUnresolvedMentionIds(text, participants, selfId);
  if (unresolved.length > 0) {
    throw new Error(
      `Cannot resolve @mention(s) to room participant(s): ${unresolved.join(", ")}. ` +
        `Add them with band_add_participant, or use band_get_participants to find the right @handle.`,
    );
  }

  // 3. No explicit mention -> auto-mention the last sender (plain-text reply UX).
  if (lastSender) {
    const sender = participants.find(
      (p) => p.id === lastSender.senderId && p.id !== selfId,
    );
    if (sender) return [toResolved(sender)];
  }

  // 4. Fall back to the first other participant.
  const other = participants.find((p) => p.id !== selfId);
  return other ? [toResolved(other)] : [];
}

// =============================================================================
// Inbound display helpers (mirror @thenvoi/sdk runtime/formatters)
// =============================================================================

/**
 * Rewrite Band's `@[[uuid]]` id tokens into readable `@handle` form so the model
 * sees and echoes handles rather than raw uuids. Tokens whose id has no handle
 * (or no matching participant) are left untouched.
 */
export function replaceUuidMentions(content: string, participants: MentionParticipant[]): string {
  if (!content || participants.length === 0) return content;
  let next = content;
  for (const p of participants) {
    if (typeof p.handle === "string" && p.handle.trim().length > 0) {
      next = next.replaceAll(`@[[${p.id}]]`, `@${p.handle}`);
    }
  }
  return next;
}

/**
 * A roster of the room's other participants with their handles, plus a one-line
 * instruction to @mention by handle. Returns "" when the agent is alone so the
 * caller can omit an empty block.
 */
export function buildParticipantsBlock(participants: MentionParticipant[], selfId: string): string {
  const others = participants.filter((p) => p.id !== selfId);
  if (others.length === 0) return "";
  const lines = ["## Participants in this room"];
  for (const p of others) {
    const handle = typeof p.handle === "string" && p.handle.trim().length > 0 ? `@${p.handle}` : "(no handle)";
    lines.push(`- ${handle} — ${p.name}`);
  }
  lines.push("");
  lines.push("To @mention someone, write their @handle exactly as shown above.");
  return lines.join("\n");
}
