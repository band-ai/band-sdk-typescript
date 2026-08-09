import type { RestRequestOptions } from "../../client/rest/requestOptions";
import { UnsupportedFeatureError } from "../../core/errors";
import type { MetadataMap } from "../../contracts/dtos";
import type { BandLink } from "../../platform/BandLink";

interface TrackRoomJoinOptions {
  link: BandLink;
  roomId: string | null;
  payload: MetadataMap;
  trackedRooms: Set<string>;
  roomFilter?: (room: MetadataMap) => boolean;
  onJoined?: (roomId: string, payload: MetadataMap) => Promise<void>;
}

interface TrackRoomLeaveOptions {
  link: BandLink;
  roomId: string | null;
  trackedRooms: Set<string>;
  onLeft?: (roomId: string) => Promise<void>;
}

interface HydrateTrackedRoomsOptions {
  link: BandLink;
  trackedRooms: Set<string>;
  roomFilter?: (room: MetadataMap) => boolean;
  onJoined?: (roomId: string, payload: MetadataMap) => Promise<void>;
  pageSize?: number;
  maxPages?: number;
  requestOptions?: RestRequestOptions;
  onError?: (error: unknown) => Promise<void> | void;
}

function hasRoomId(roomId: string | null): roomId is string {
  return typeof roomId === "string" && roomId.length > 0;
}

export async function trackRoomJoin(options: TrackRoomJoinOptions): Promise<boolean> {
  if (!hasRoomId(options.roomId)) {
    return false;
  }

  if (options.roomFilter && !options.roomFilter(options.payload)) {
    return false;
  }

  if (options.trackedRooms.has(options.roomId)) {
    return false;
  }

  await options.link.subscribeRoom(options.roomId);
  options.trackedRooms.add(options.roomId);
  if (options.onJoined) {
    await options.onJoined(options.roomId, options.payload);
  }

  return true;
}

export async function trackRoomLeave(options: TrackRoomLeaveOptions): Promise<boolean> {
  if (!hasRoomId(options.roomId) || !options.trackedRooms.has(options.roomId)) {
    return false;
  }

  await options.link.unsubscribeRoom(options.roomId);
  options.trackedRooms.delete(options.roomId);
  if (options.onLeft) {
    await options.onLeft(options.roomId);
  }

  return true;
}

export async function hydrateTrackedRooms(options: HydrateTrackedRoomsOptions): Promise<void> {
  const pageSize = options.pageSize ?? 100;
  const maxPages = options.maxPages ?? 100;

  try {
    const rooms = await options.link.listAllChats(
      { pageSize, maxPages },
      options.requestOptions,
    );

    for (const room of rooms) {
      await trackRoomJoin({
        link: options.link,
        roomId: typeof room.id === "string" ? room.id : null,
        payload: room,
        trackedRooms: options.trackedRooms,
        roomFilter: options.roomFilter,
        onJoined: options.onJoined,
      });
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
