import type { RestRequestOptions } from "../../client/rest/requestOptions";
import { UnsupportedFeatureError } from "../../core/errors";
import type { MetadataMap } from "../../contracts/dtos";
import type { BandLink } from "../../platform/BandLink";

export interface ExistingRoomsOptions {
  link: BandLink;
  roomFilter?: (room: MetadataMap) => boolean;
  onRoom: (roomId: string, payload: MetadataMap) => Promise<void>;
  pageSize?: number;
  maxPages?: number;
  requestOptions?: RestRequestOptions;
  onError?: (error: unknown) => Promise<void> | void;
}

export async function hydrateExistingRooms(options: ExistingRoomsOptions): Promise<void> {
  const pageSize = options.pageSize ?? 100;
  const maxPages = options.maxPages ?? 100;

  try {
    const rooms = await options.link.listAllChats(
      { pageSize, maxPages },
      options.requestOptions,
    );

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
