import type { AdapterToolsProtocol, Logger } from "@band-ai/sdk/core";

export interface RoomParticipant {
  id: string;
  name: string;
  handle?: string | null;
}

export interface LastSender {
  senderId: string;
  senderName: string;
}

/** Per-room "who sent the last forwarded message" — the fallback's primary source. */
export class LastSenderTracker {
  private readonly byRoom = new Map<string, LastSender>();

  public track(roomId: string, sender: LastSender): void {
    this.byRoom.set(roomId, sender);
  }

  public get(roomId: string): LastSender | undefined {
    return this.byRoom.get(roomId);
  }
}

function mentionToken(participant: RoomParticipant): string {
  return typeof participant.handle === "string" && participant.handle.trim().length > 0
    ? participant.handle
    : participant.id;
}

/**
 * `band_send_message`'s `mentions` array is documented as required, but
 * nothing enforces that at the MCP protocol layer (the JSON schema's
 * `minItems` isn't translated into a Zod constraint) or in
 * `AgentTools.sendMessage` (an empty array is accepted and sends an
 * unmentioned, undelivered-notification message). Resolve a sensible default
 * so an empty `mentions` array doesn't silently produce a reply nobody is
 * notified about: the last sender in the room, else the first other
 * participant, else `undefined` (nothing to mention — an agent-only room).
 */
export function resolveMentionFallback(
  participants: readonly RoomParticipant[],
  selfId: string,
  lastSender?: LastSender | null,
): string | undefined {
  if (lastSender) {
    const sender = participants.find((p) => p.id === lastSender.senderId && p.id !== selfId);
    if (sender) return mentionToken(sender);
  }

  const other = participants.find((p) => p.id !== selfId);
  return other ? mentionToken(other) : undefined;
}

export interface MentionFallbackDeps {
  listParticipants: (roomId: string) => Promise<RoomParticipant[]>;
  selfId: string;
  lastSenderTracker: LastSenderTracker;
  logger: Logger;
}

function hasExplicitMentions(toolArgs: Record<string, unknown>): boolean {
  const mentions = toolArgs.mentions;
  return Array.isArray(mentions) && mentions.length > 0;
}

/** Wrap a room's tools so a `band_send_message` call with no mentions gets the fallback injected. */
export function wrapToolsForMentionFallback(
  tools: AdapterToolsProtocol,
  roomId: string,
  deps: MentionFallbackDeps,
): AdapterToolsProtocol {
  return {
    ...tools,
    executeToolCall: async (toolName, toolArgs) => {
      if (toolName !== "band_send_message" || hasExplicitMentions(toolArgs)) {
        return tools.executeToolCall(toolName, toolArgs);
      }

      let participants: RoomParticipant[] = [];
      try {
        participants = await deps.listParticipants(roomId);
      } catch (error) {
        deps.logger.warn("could not list participants for mention fallback", {
          room_id: roomId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      const fallback = resolveMentionFallback(participants, deps.selfId, deps.lastSenderTracker.get(roomId));
      const nextArgs = fallback ? { ...toolArgs, mentions: [fallback] } : toolArgs;
      return tools.executeToolCall(toolName, nextArgs);
    },
  };
}
