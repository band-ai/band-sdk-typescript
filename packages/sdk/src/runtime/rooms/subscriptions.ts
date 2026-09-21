import type { RestRequestOptions } from "../../client/rest/requestOptions";
import { UnsupportedFeatureError } from "../../core/errors";
import type { MetadataMap } from "../../contracts/dtos";
import type { BandLink } from "../../platform/BandLink";

export interface ListExistingRoomsOptions {
  link: BandLink;
  roomFilter?: (room: MetadataMap) => boolean;
  requestOptions?: RestRequestOptions;
}

export interface ExistingRoomsOptions extends ListExistingRoomsOptions {
  onRoom: (roomId: string, payload: MetadataMap) => Promise<void>;
  onError?: (error: unknown) => Promise<void> | void;
}

/**
 * The single accepted, filtered, deduplicated room snapshot: every other
 * caller that needs "the current room list" (startup hydration, reconnect
 * reconciliation) builds on this rather than re-deriving its own filtered
 * view of the raw REST response.
 */
export async function listExistingRooms(
  options: ListExistingRoomsOptions,
): Promise<Map<string, MetadataMap>> {
  // No caller has ever needed non-default pagination here; `listAllChats`
  // already applies its own pageSize/maxPages defaults when omitted.
  const rooms = await options.link.listAllChats(undefined, options.requestOptions);

  const accepted = new Map<string, MetadataMap>();
  for (const room of rooms) {
    const roomId = typeof room.id === "string" ? room.id : null;
    if (!roomId) {
      continue;
    }
    if (options.roomFilter && !options.roomFilter(room)) {
      continue;
    }
    accepted.set(roomId, room);
  }
  return accepted;
}

export async function hydrateExistingRooms(options: ExistingRoomsOptions): Promise<void> {
  try {
    const rooms = await listExistingRooms(options);
    for (const [roomId, payload] of rooms) {
      await options.onRoom(roomId, payload);
    }
  } catch (error) {
    if (error instanceof UnsupportedFeatureError) {
      return;
    }

    if (options.onError) {
      await options.onError(error);
      return;
    }

    throw error;
  }
}
