import type { MetadataMap } from "./dtos";

/**
 * Message-metadata keys a bridge sets so a framework adapter can decide how to treat the
 * conversation thread it keeps for a room.
 *
 * The keys are vertical-neutral on purpose: an adapter must not have to know which
 * integration produced a message, and an integration must be removable without editing a
 * generic adapter.
 */
export const BRIDGE_METADATA_KEYS = {
  /** Identifier of the bridge-side session a message belongs to. */
  sessionId: "bridge_session_id",
  /** Identifier of the bridge-side work item (issue, ticket, task) a message belongs to. */
  issueId: "bridge_issue_id",
  /** Set to `true` to make the adapter start a fresh thread instead of resuming one. */
  resetThread: "reset_adapter_thread",
} as const;

/**
 * The integration-specific spellings the neutral keys above replaced.
 *
 * Metadata keys are a runtime contract with no compile-time signal, so anyone running
 * their own bridge would break silently on a one-step cutover. Bridges therefore write
 * both spellings and adapters read both for one release.
 *
 * Remove this constant, the fallback in `readBridgeMetadataValue`, and the duplicate
 * writes in the Linear bridge in 0.2.0.
 */
export const LEGACY_BRIDGE_METADATA_KEYS = {
  sessionId: "linear_session_id",
  issueId: "linear_issue_id",
  resetThread: "linear_reset_room_session",
} as const;

type BridgeMetadataField = keyof typeof BRIDGE_METADATA_KEYS;

function readBridgeMetadataValue(
  metadata: MetadataMap | undefined,
  field: BridgeMetadataField,
): unknown {
  const value = metadata?.[BRIDGE_METADATA_KEYS[field]];
  if (value !== undefined) {
    return value;
  }

  // Legacy fallback -- remove together with LEGACY_BRIDGE_METADATA_KEYS in 0.2.0.
  return metadata?.[LEGACY_BRIDGE_METADATA_KEYS[field]];
}

/** Bridge session id carried by a message, or `null` when the bridge set none. */
export function readBridgeSessionId(metadata: MetadataMap | undefined): unknown {
  return readBridgeMetadataValue(metadata, "sessionId") ?? null;
}

/** Bridge work-item id carried by a message, or `null` when the bridge set none. */
export function readBridgeIssueId(metadata: MetadataMap | undefined): unknown {
  return readBridgeMetadataValue(metadata, "issueId") ?? null;
}

/**
 * Whether the bridge asked the adapter to abandon the thread it holds for the room and
 * start a new one — typically because a previous session finished or errored.
 */
export function shouldResetAdapterThread(metadata: MetadataMap | undefined): boolean {
  return readBridgeMetadataValue(metadata, "resetThread") === true;
}
