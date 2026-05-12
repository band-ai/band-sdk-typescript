import type { RestRequestOptions } from "../../client/rest/requestOptions";
import { TransportError, UnsupportedFeatureError } from "../../core/errors";
import type { MetadataMap } from "../../contracts/dtos";
import type { ThenvoiLink } from "../../platform/ThenvoiLink";

interface TrackRoomJoinOptions {
  link: ThenvoiLink;
  roomId: string | null;
  payload: MetadataMap;
  trackedRooms: Set<string>;
  roomFilter?: (room: MetadataMap) => boolean;
  onJoined?: (roomId: string, payload: MetadataMap) => Promise<void>;
}

interface TrackRoomLeaveOptions {
  link: ThenvoiLink;
  roomId: string | null;
  trackedRooms: Set<string>;
  onLeft?: (roomId: string) => Promise<void>;
}

interface HydrateTrackedRoomsOptions {
  link: ThenvoiLink;
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

const ROOM_JOIN_RETRY_DELAYS_MS = [0, 2_000];

function isRetryableRoomJoinError(error: unknown): boolean {
  return error instanceof TransportError && /Timeout joining topic/.test(error.message);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function subscribeRoomWithRetry(link: ThenvoiLink, roomId: string): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < ROOM_JOIN_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      await sleep(ROOM_JOIN_RETRY_DELAYS_MS[attempt] ?? 0);
    }

    try {
      await link.subscribeRoom(roomId);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableRoomJoinError(error) || attempt === ROOM_JOIN_RETRY_DELAYS_MS.length - 1) {
        throw error;
      }
    }
  }

  throw lastError;
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

  await subscribeRoomWithRetry(options.link, options.roomId);
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

    await Promise.all(
      rooms.map(async (room) => {
        try {
          await trackRoomJoin({
            link: options.link,
            roomId: typeof room.id === "string" ? room.id : null,
            payload: room,
            trackedRooms: options.trackedRooms,
            roomFilter: options.roomFilter,
            onJoined: options.onJoined,
          });
        } catch (error) {
          if (options.onError) {
            await options.onError(error);
            return;
          }
          throw error;
        }
      }),
    );
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
