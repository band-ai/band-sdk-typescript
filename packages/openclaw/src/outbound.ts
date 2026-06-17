/**
 * Band outbound send logic.
 *
 * The normal reply path flows through core's shared message tool + this adapter
 * (the legacy `*_send_message` tool is dropped). Band requires every chat
 * message to carry at least one @mention, so this is the single choke point that
 * enforces the mandatory-mention invariant: resolve mentions (explicit @Name in
 * the reply text -> last sender -> first other participant) and THROW if that
 * resolves to nothing.
 *
 * Dependencies are injected ({ rest, selfAgentId, getLastSender }) so the logic
 * is unit-testable with vi.fn() spies and holds no global state; the channel
 * wiring supplies the live deps from the connected account.
 */

import type { ThenvoiLink } from "@thenvoi/sdk";
import { resolveMentions, type LastSender } from "./mentions.js";

type BandRest = ThenvoiLink["rest"];

export interface OutboundDeps {
  rest: BandRest;
  selfAgentId: string;
  /** Look up the last sender for a room (for the auto-mention fallback). */
  getLastSender?: (roomId: string) => LastSender | null | undefined;
}

export interface SendParams {
  to: string;
  text: string;
}

export interface SendMediaParams extends SendParams {
  mediaUrl?: string;
}

export interface SendResult {
  messageId: string;
}

/**
 * Send a text message to a Band room: resolve mentions, post via REST, return
 * the message id. Throws if no room is given or no mention can be resolved.
 */
export async function sendText(deps: OutboundDeps, params: SendParams): Promise<SendResult> {
  const roomId = params.to?.trim();
  if (!roomId) {
    throw new Error("Band requires a room_id as the send target");
  }

  const participants = await deps.rest.listChatParticipants(roomId);
  const mentions = resolveMentions({
    participants,
    selfId: deps.selfAgentId,
    text: params.text,
    lastSender: deps.getLastSender?.(roomId) ?? null,
  });

  if (mentions.length === 0) {
    throw new Error(
      `Cannot send to room ${roomId}: no other participant to @mention (Band requires at least one mention)`,
    );
  }

  const result = await deps.rest.createChatMessage(roomId, { content: params.text, mentions });
  if (result?.id == null) {
    // A posted message with no id is an API-contract anomaly; surface it rather
    // than silently fabricating success unobserved.
    console.warn(`[band] createChatMessage returned no id for room ${roomId}; using a fabricated id`);
  }
  return { messageId: String(result?.id ?? `band-${Date.now()}`) };
}

/**
 * Send media: Band has no native media upload on this path, so the URL is
 * appended to the text and delivered through the same send path.
 */
export async function sendMedia(deps: OutboundDeps, params: SendMediaParams): Promise<SendResult> {
  const text = params.mediaUrl
    ? params.text
      ? `${params.text}\n\n${params.mediaUrl}`
      : params.mediaUrl
    : params.text;
  return sendText(deps, { to: params.to, text });
}
