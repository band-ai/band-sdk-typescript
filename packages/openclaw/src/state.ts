/**
 * Module-scoped account registry for the Band channel.
 *
 * Per D6 (architect consensus Q6): a module-scoped Map keyed by accountId, NOT a
 * globalThis registry. It holds the per-account state that the TOOLS path and the
 * OUTBOUND adapter need without a gateway context — the connected ThenvoiLink,
 * the agent's own id + owner id (F2), a room-type cache (L2 ChatType), and an LRU
 * last-sender cache (auto-mention fallback). `resetAccounts()` exists for test
 * isolation.
 */

import type { ThenvoiLink } from "@thenvoi/sdk";
import type { LastSender } from "./mentions.js";

export interface AccountState {
  link: ThenvoiLink;
  /** The agent's own id (self), for excluding self + skipping self-authored. */
  selfAgentId: string;
  /** The agent owner's id; commands are authorized only for the owner (F2). */
  ownerUuid?: string | null;
  /** The AgentRuntime instance (opaque here), so teardown can stop it. */
  runtime?: unknown;
  /** roomId -> room type (populated from onRoomJoined; drives L2 ChatType). */
  roomTypes: Map<string, string>;
  /** roomId -> last sender (LRU; auto-mention fallback). */
  lastSenders: Map<string, LastSender>;
}

/** Fields a caller supplies when registering an account (caches are created here). */
export type AccountStateInput = Omit<AccountState, "roomTypes" | "lastSenders"> &
  Partial<Pick<AccountState, "roomTypes" | "lastSenders">>;

export const MAX_LAST_SENDERS = 500;

// Module-scoped — survives only for the life of the module, never on globalThis.
const accounts = new Map<string, AccountState>();

export function setAccount(accountId: string, input: AccountStateInput): void {
  accounts.set(accountId, {
    ...input,
    roomTypes: input.roomTypes ?? new Map<string, string>(),
    lastSenders: input.lastSenders ?? new Map<string, LastSender>(),
  });
}

export function getAccount(accountId = "default"): AccountState | undefined {
  return accounts.get(accountId);
}

export function getLink(accountId = "default"): ThenvoiLink | undefined {
  return accounts.get(accountId)?.link;
}

/**
 * Resolve the connected account for the tools path, which gets no accountId.
 *
 * Tools are single-account (D6), but the account is keyed by its CONFIGURED id
 * (e.g. `band-openclaw-accounr-id`), not literally `"default"` — so hardcoding
 * `getAccount("default")` fails whenever the operator named the account anything
 * else. Resolve the sole connected account instead: use `"default"` if present,
 * otherwise the unique connected account. Returns undefined if none/ambiguous.
 */
export function resolveSingleAccount(): { accountId: string; state: AccountState } | undefined {
  const preferred = accounts.get("default");
  if (preferred) return { accountId: "default", state: preferred };
  if (accounts.size === 1) {
    const [accountId, state] = accounts.entries().next().value!;
    return { accountId, state };
  }
  return undefined;
}

/**
 * Resolve the account a tools/outbound call should use, given an OPTIONAL id.
 *
 * Both the tools path (index.ts, no id) and the outbound adapter (channel.ts,
 * `ctx.accountId` which is null for cross-context sends) need the same policy, so
 * it lives here once:
 *  - An EXPLICIT id must match a connected account, or this returns undefined —
 *    it never silently substitutes a different account (which would misroute a
 *    send to the wrong Band identity).
 *  - With NO id, fall back to the sole connected account (`resolveSingleAccount`).
 */
export function resolveAccount(
  accountId?: string | null,
): { accountId: string; state: AccountState } | undefined {
  if (accountId != null && accountId !== "") {
    const state = accounts.get(accountId);
    return state ? { accountId, state } : undefined;
  }
  return resolveSingleAccount();
}

export function deleteAccount(accountId: string): void {
  accounts.delete(accountId);
}

/** Clear the whole registry. For test isolation. */
export function resetAccounts(): void {
  accounts.clear();
}

// --- room-type cache (L2) ---------------------------------------------------

export function cacheRoomType(accountId: string, roomId: string, type: string): void {
  accounts.get(accountId)?.roomTypes.set(roomId, type);
}

export function getRoomType(accountId: string, roomId: string): string | undefined {
  return accounts.get(accountId)?.roomTypes.get(roomId);
}

// --- last-sender LRU cache (auto-mention fallback) --------------------------

export function trackLastSender(accountId: string, roomId: string, sender: LastSender): void {
  const state = accounts.get(accountId);
  if (!state) return;
  const cache = state.lastSenders;
  // Delete-then-set moves the entry to the most-recently-used position.
  cache.delete(roomId);
  cache.set(roomId, sender);
  if (cache.size > MAX_LAST_SENDERS) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

export function getLastSender(accountId: string, roomId: string): LastSender | undefined {
  return accounts.get(accountId)?.lastSenders.get(roomId);
}
