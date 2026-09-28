/**
 * Shared pieces for the rehydration matrix. These scenarios build their own
 * `Agents.cell` / `runAs` lifecycle instead of `perAdapter`, which eagerly
 * boots an adapter before the test body runs.
 */
import { LIVE_EVENT_TIMEOUT_MS } from "../../../integration/support/liveHarness";
import { ADAPTER, type AdapterId, type RosterSpec } from "../../toolkit/adapters";
import { unmetRequirements } from "../../toolkit/registry";

/**
 * Resume their own backend session on restart instead of reading platform
 * `/context`. Offline/partial rehydration scenarios exclude only these two;
 * idempotency and cross-framework also exclude ACP session-backed adapters.
 */
export const OWN_SESSION_RESUME_ADAPTERS: readonly AdapterId[] = [ADAPTER.codex, ADAPTER.opencode];

/** Platform `/context` rehydration assertions cannot validate these adapters. */
export const SESSION_BACKED_ADAPTERS: readonly AdapterId[] = [
  ...OWN_SESSION_RESUME_ADAPTERS,
  ADAPTER.copilotAcp,
  ADAPTER.ompAcp,
];

export const REHYDRATION_EXTENDED_WAIT_MS = LIVE_EVENT_TIMEOUT_MS + 300_000;
export const REHYDRATION_COLD_BOOT_WAIT_MS = LIVE_EVENT_TIMEOUT_MS + 180_000;

/** Per-test ceiling: several default live barriers plus one extended boot/recall wait (baseline default is `LIVE_EVENT_TIMEOUT_MS * 3`). */
export const REHYDRATION_SCENARIO_TIMEOUT_MS = REHYDRATION_EXTENDED_WAIT_MS + LIVE_EVENT_TIMEOUT_MS * 4;

export const REHYDRATE_PROMPT =
  "You are a helpful assistant in a chat room. Reply directly with one short sentence. " +
  "When asked to remember something, acknowledge it; when later asked what it was, state it exactly.";

export const remember = (note: string): string => `Please remember this note: ${note}. Confirm you remember it.`;

export const RECALL = "What was the note I asked you to remember? Reply with just it.";

export function assertRunnable(spec: RosterSpec): void {
  const unmet = unmetRequirements(spec);
  if (unmet.length > 0) {
    throw new Error(`cannot run ${spec.id}: ${unmet.join("; ")}`);
  }
}
