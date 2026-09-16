import type { HistoryConverter } from "../contracts/protocols";

export interface ACPClientSessionState {
  roomToSession: Record<string, string>;
}

export class ACPClientHistoryConverter implements HistoryConverter<ACPClientSessionState> {
  public convert(raw: Array<Record<string, unknown>>): ACPClientSessionState {
    const roomToSession: Record<string, string> = {};

    for (const entry of raw) {
      // Only the adapter's own "ACP client session" task event ever carries
      // this metadata (see ACPClientAdapter's `establishSession`), and always
      // with `room_id` stamped to the room that produced it. `metadata` is
      // otherwise attacker-controlled — an agent can post arbitrary fields
      // via `band_send_event` — so trusting `metadata.acp_client_room_id` on
      // its own would let a forged entry reroute a *different* room's
      // session onto this one. Cross-checking against `entry.room_id`, which
      // the runtime itself always stamps to the entry's real room, closes
      // that gap.
      if (entry.message_type !== "task") {
        continue;
      }

      const metadataRaw = entry.metadata;
      if (!metadataRaw || typeof metadataRaw !== "object" || Array.isArray(metadataRaw)) {
        continue;
      }
      const metadata = metadataRaw as Record<string, unknown>;

      const sessionId = metadata.acp_client_session_id;
      const roomId = metadata.acp_client_room_id;
      if (
        typeof sessionId === "string" && typeof roomId === "string" && sessionId && roomId
        && roomId === entry.room_id
      ) {
        roomToSession[roomId] = sessionId;
      }
    }

    return { roomToSession };
  }
}
