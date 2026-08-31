import type { HistoryConverter } from "../../contracts/protocols";
import { asNonEmptyString, asOptionalRecord } from "../../core/coercion";

import type { GatewaySessionState } from "./types";

/**
 * Rebuilds the A2A gateway's session state (context-to-room bindings and per-room
 * participants) from a room's task-event history, so a restarted gateway keeps serving the
 * same `contextId`s.
 */
export class GatewayHistoryConverter
  implements HistoryConverter<GatewaySessionState>
{
  public convert(raw: Array<Record<string, unknown>>): GatewaySessionState {
    const contextToRoom: Record<string, string> = {};
    const roomParticipants = new Map<string, Set<string>>();

    for (const entry of raw) {
      const metadata = asOptionalRecord(entry.metadata) ?? {};
      const contextId = asNonEmptyString(metadata.gateway_context_id);
      if (contextId) {
        const roomId =
          asNonEmptyString(metadata.gateway_room_id) ??
          asNonEmptyString(entry.room_id) ??
          asNonEmptyString(entry.roomId);
        if (roomId) {
          contextToRoom[contextId] = roomId;
        }
      }

      const senderType = (
        asNonEmptyString(entry.sender_type) ?? asNonEmptyString(entry.senderType) ?? ""
      )
        .trim()
        .toLowerCase();
      const roomId = asNonEmptyString(entry.room_id) ?? asNonEmptyString(entry.roomId);
      const senderId = asNonEmptyString(entry.sender_id) ?? asNonEmptyString(entry.senderId);
      if (senderType !== "agent" || !roomId || !senderId) {
        continue;
      }

      const participants = roomParticipants.get(roomId) ?? new Set<string>();
      participants.add(senderId);
      roomParticipants.set(roomId, participants);
    }

    const serializedParticipants: Record<string, string[]> = {};
    for (const [roomId, participants] of roomParticipants) {
      serializedParticipants[roomId] = [...participants];
    }

    return {
      contextToRoom,
      roomParticipants: serializedParticipants,
    };
  }
}
