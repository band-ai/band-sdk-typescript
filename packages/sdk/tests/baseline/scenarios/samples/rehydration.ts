/**
 * Shared pieces for the rehydration matrix: adapters a platform `/context`
 * rehydration assertion can't validate, the remember/recall wording every
 * scenario in the matrix runs its agents on, and the fail-loud dependency
 * check a scenario needs when it builds a cell itself instead of going
 * through `perAdapter` (these scenarios manage their own boot timing, so
 * `perAdapter`'s eager cast-opening doesn't fit).
 */
import { ADAPTER, type AdapterId, type RosterSpec } from "../../toolkit/adapters";
import { unmetRequirements } from "../../toolkit/registry";

/**
 * Adapters excluded from a platform-`/context` rehydration assertion: each
 * resumes its own backend/CLI/ACP session on restart instead of reading
 * platform `/context`, so a pass on one of these wouldn't validate the
 * rehydration these scenarios assert. `codex` is currently `pending` (never
 * run live), kept here anyway so the reason travels with the id if it is
 * ever brought live.
 */
export const SESSION_BACKED_ADAPTERS: readonly AdapterId[] = [ADAPTER.codex, ADAPTER.opencode, ADAPTER.copilotAcp, ADAPTER.ompAcp];

/** The steering prompt every rehydration scenario runs its agents on. */
export const REHYDRATE_PROMPT =
  "You are a helpful assistant in a chat room. Reply directly with one short sentence. " +
  "When asked to remember something, acknowledge it; when later asked what it was, state it exactly.";

/** Asks the agent to remember `note` — a neutral "note", never a credential-shaped value models refuse to echo. */
export const remember = (note: string): string => `Please remember this note: ${note}. Confirm you remember it.`;

export const RECALL = "What was the note I asked you to remember? Reply with just it.";

/** Fails loudly, naming what's missing, before a scenario that builds its own cell (bypassing `perAdapter`) uses `spec`. */
export function assertRunnable(spec: RosterSpec): void {
  const unmet = unmetRequirements(spec);
  if (unmet.length > 0) {
    throw new Error(`cannot run ${spec.id}: ${unmet.join("; ")}`);
  }
}
