/**
 * Sender gate + mention gate + meta sanitization for inbound Band messages.
 *
 * An ungated channel is a prompt-injection vector: anyone who can reach the
 * agent's Band room can put text in front of Claude. Both gates below must
 * pass before a message is forwarded as a `notifications/claude/channel`
 * push — see the module doc on `shouldForwardMessage`.
 */

export interface SelfIdentity {
  id: string;
  name: string;
  handle?: string | null;
}

/** Parse the plugin's `allowed_senders` userConfig value: a comma-separated id list. */
export function parseAllowedSenders(raw: string | undefined | null): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

/** Sender gate: the agent's owner, or an id in the configured allowlist. */
export function isSenderAllowed(
  senderId: string,
  ownerId: string,
  allowedSenderIds: ReadonlySet<string>,
): boolean {
  return senderId === ownerId || allowedSenderIds.has(senderId);
}

/** Escape a string for safe inclusion in a RegExp. */
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
 * mention.
 */
const HANDLE_MENTION_PATTERN = "(?<![\\w])@([A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9._-]+)?)";

/** Is `@name` present in `text` as a real mention token (not inside a longer word or an email)? */
function mentionPresent(text: string, name: string): boolean {
  const re = new RegExp(`(?<![\\w])@${escapeRegExp(name)}(?![\\w])`, "i");
  return re.test(text);
}

/**
 * Mention gate: does `text` explicitly @-mention `self`, by id token
 * (`@[[uuid]]`), handle (`@handle`), or display name (`@Full Name`)?
 */
export function isSelfMentioned(text: string, self: SelfIdentity): boolean {
  if (!text) return false;

  for (const match of text.matchAll(new RegExp(UUID_MENTION_PATTERN, "g"))) {
    if (match[1] === self.id) return true;
  }

  const withoutIds = text.replace(new RegExp(UUID_MENTION_PATTERN, "g"), " ");

  if (typeof self.handle === "string" && self.handle.trim().length > 0) {
    const selfHandle = normalizeHandle(self.handle);
    for (const match of withoutIds.matchAll(new RegExp(HANDLE_MENTION_PATTERN, "gi"))) {
      const raw = match[1];
      if (raw && normalizeHandle(raw) === selfHandle) return true;
    }
  }

  if (self.name && mentionPresent(withoutIds, self.name)) return true;

  return false;
}

/** True iff the room's only two participants are this agent and its owner. */
export function isDirectRoomWithOwner(
  roomParticipantIds: readonly string[],
  selfId: string,
  ownerId: string,
): boolean {
  if (roomParticipantIds.length !== 2) return false;
  return roomParticipantIds.includes(selfId) && roomParticipantIds.includes(ownerId);
}

export interface ShouldForwardParams {
  text: string;
  senderId: string;
  self: SelfIdentity;
  ownerId: string;
  allowedSenderIds: ReadonlySet<string>;
  /** Every participant id currently in the room, including this agent and the sender. */
  roomParticipantIds: readonly string[];
}

/**
 * Both gates must pass: the sender must be the owner (or allowlisted), AND
 * the message must @-mention this agent — except a 1:1 room with only the
 * owner and this agent, which is always treated as mentioned (no reason to
 * force `@agent` in a DM).
 */
export function shouldForwardMessage(params: ShouldForwardParams): boolean {
  const { text, senderId, self, ownerId, allowedSenderIds, roomParticipantIds } = params;

  if (!isSenderAllowed(senderId, ownerId, allowedSenderIds)) {
    return false;
  }

  if (isDirectRoomWithOwner(roomParticipantIds, self.id, ownerId)) {
    return true;
  }

  return isSelfMentioned(text, self);
}

const META_KEY_PATTERN = /^[A-Za-z0-9_]+$/;

/**
 * `notifications/claude/channel`'s `meta` is `Record<string, string>` with
 * identifier-only keys (letters, digits, underscore) — Claude Code silently
 * drops any other key. Enforce that here rather than relying on the host to
 * drop malformed keys quietly.
 */
export function sanitizeMeta(raw: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!META_KEY_PATTERN.test(key)) continue;
    if (value === undefined || value === null) continue;
    result[key] = String(value);
  }
  return result;
}
