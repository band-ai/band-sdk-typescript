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
  onError?: (error: unknown) => Promise<void> | void;
}

interface HydrateTrackedRoomsOptions {
  link: ThenvoiLink;
  trackedRooms: Set<string>;
  roomFilter?: (room: MetadataMap) => boolean;
  onJoined?: (roomId: string, payload: MetadataMap) => Promise<void>;
  onLeft?: (roomId: string) => Promise<void>;
  pruneMissing?: boolean;
  pageSize?: number;
  maxPages?: number;
  requestOptions?: RestRequestOptions;
  onError?: (error: unknown) => Promise<void> | void;
}

function hasRoomId(roomId: string | null): roomId is string {
  return typeof roomId === "string" && roomId.length > 0;
}

const ROOM_JOIN_RETRY_DELAYS_MS = [0, 500, 2_000];
const HYDRATE_CONCURRENCY = 6;
const pendingJoinsByTrackedRooms = new WeakMap<Set<string>, Set<string>>();

function pendingJoinsFor(trackedRooms: Set<string>): Set<string> {
  let pending = pendingJoinsByTrackedRooms.get(trackedRooms);
  if (!pending) {
    pending = new Set<string>();
    pendingJoinsByTrackedRooms.set(trackedRooms, pending);
  }
  return pending;
}

function isRetryableRoomJoinError(error: unknown): boolean {
  if (!(error instanceof TransportError)) return false;
  // Phoenix timeouts and transient join errors are safe to retry — the topic
  // either failed to confirm or the socket was mid-reconnect. Permanent errors
  // (auth, missing room) will continue to fail on retry and be surfaced.
  return /Timeout joining topic|Failed to join topic/.test(error.message);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, concurrency);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
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

  const pendingJoins = pendingJoinsFor(options.trackedRooms);
  if (options.trackedRooms.has(options.roomId) || pendingJoins.has(options.roomId)) {
    return false;
  }

  pendingJoins.add(options.roomId);
  try {
    await subscribeRoomWithRetry(options.link, options.roomId);
    if (options.trackedRooms.has(options.roomId)) {
      return false;
    }

    options.trackedRooms.add(options.roomId);
    if (options.onJoined) {
      await options.onJoined(options.roomId, options.payload);
    }

    return true;
  } finally {
    pendingJoins.delete(options.roomId);
  }
}

export async function trackRoomLeave(options: TrackRoomLeaveOptions): Promise<boolean> {
  if (!hasRoomId(options.roomId) || !options.trackedRooms.has(options.roomId)) {
    return false;
  }

  // Drop the room from tracking up front. If the server already deleted the
  // room, the underlying Phoenix topic is gone and `unsubscribeRoom` may throw
  // — but the room is no longer reachable, which is the goal state, so the
  // tracking set must reflect that regardless of how the leave call resolves.
  pendingJoinsFor(options.trackedRooms).delete(options.roomId);
  options.trackedRooms.delete(options.roomId);

  try {
    await options.link.unsubscribeRoom(options.roomId);
  } catch (error) {
    // Treat leave failures as "already gone" so consumers still fire `onLeft`
    // and so retries don't deadlock on a topic the server has discarded.
    if (options.onError) {
      await options.onError(error);
    }
  }

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

    const currentRoomIds = new Set(
      rooms
        .map((room) => (typeof room.id === "string" ? room.id : null))
        .filter((roomId): roomId is string => roomId !== null),
    );

    if (options.pruneMissing) {
      const stale = [...options.trackedRooms].filter((roomId) => !currentRoomIds.has(roomId));
      await runWithConcurrency(stale, HYDRATE_CONCURRENCY, async (roomId) => {
        try {
          await trackRoomLeave({
            link: options.link,
            roomId,
            trackedRooms: options.trackedRooms,
            onLeft: options.onLeft,
            onError: options.onError,
          });
        } catch (error) {
          if (options.onError) {
            await options.onError(error);
            return;
          }
          throw error;
        }
      });
    }

    await runWithConcurrency(rooms, HYDRATE_CONCURRENCY, async (room) => {
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
    });
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
