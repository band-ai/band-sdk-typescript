import type { RestRequestOptions } from "../../client/rest/requestOptions";
import { UnsupportedFeatureError } from "../../core/errors";
import type { MetadataMap } from "../../contracts/dtos";
import type { BandLink } from "../../platform/BandLink";

export interface ExistingRoomsOptions {
  link: BandLink;
  roomFilter?: (room: MetadataMap) => boolean;
  onRoom: (roomId: string, payload: MetadataMap) => Promise<void>;
  requestOptions?: RestRequestOptions;
  onError?: (error: unknown) => Promise<void> | void;
}

export async function hydrateExistingRooms(options: ExistingRoomsOptions): Promise<void> {
  try {
    // No caller has ever needed non-default pagination here; `listAllChats`
    // already applies its own pageSize/maxPages defaults when omitted.
    const rooms = await options.link.listAllChats(undefined, options.requestOptions);

    for (const room of rooms) {
      const roomId = typeof room.id === "string" ? room.id : null;
      if (!roomId) {
        continue;
      }
      if (options.roomFilter && !options.roomFilter(room)) {
        continue;
      }
      await options.onRoom(roomId, room);
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
