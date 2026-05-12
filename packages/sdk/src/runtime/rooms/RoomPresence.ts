import type { MetadataMap } from "../../contracts/dtos";
import { DEFAULT_REQUEST_OPTIONS } from "../../client/rest/requestOptions";
import type { ThenvoiLink } from "../../platform/ThenvoiLink";
import type { ContactEvent, PlatformEvent } from "../../platform/events";
import type { Logger } from "../../core/logger";
import { NoopLogger } from "../../core/logger";
import { hydrateTrackedRooms, trackRoomJoin, trackRoomLeave } from "./subscriptions";

interface RoomPresenceOptions {
  link: ThenvoiLink;
  roomFilter?: (room: MetadataMap) => boolean;
  autoSubscribeExistingRooms?: boolean;
  recoverySweepIntervalMs?: number;
  logger?: Logger;
}

type RoomPresenceJoinHandler = (roomId: string, payload: MetadataMap) => Promise<void>;
type RoomPresenceLeaveHandler = (roomId: string) => Promise<void>;
type RoomPresenceEventHandler = (roomId: string, event: PlatformEvent) => Promise<void>;
type RoomPresenceContactHandler = (event: ContactEvent) => Promise<void>;

export class RoomPresence {
  public readonly rooms = new Set<string>();
  public onRoomJoined: RoomPresenceJoinHandler | null = null;
  public onRoomLeft: RoomPresenceLeaveHandler | null = null;
  public onRoomEvent: RoomPresenceEventHandler | null = null;
  public onContactEvent: RoomPresenceContactHandler | null = null;

  private readonly link: ThenvoiLink;
  private readonly roomFilter?: (room: MetadataMap) => boolean;
  private readonly autoSubscribeExistingRooms: boolean;
  private readonly recoverySweepIntervalMs?: number;
  private readonly logger: Logger;
  private readonly roomTasks = new Map<string, Promise<void>>();
  private readonly activeTasks = new Set<Promise<void>>();
  private eventController: AbortController | null = null;
  private eventTask: Promise<void> | null = null;
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;
  private recoverySweepInFlight = false;
  private contactsSubscribed = false;

  public constructor(options: RoomPresenceOptions) {
    this.link = options.link;
    this.roomFilter = options.roomFilter;
    this.autoSubscribeExistingRooms = options.autoSubscribeExistingRooms ?? true;
    this.recoverySweepIntervalMs = options.recoverySweepIntervalMs;
    this.logger = options.logger ?? new NoopLogger();
  }

  public async start(): Promise<void> {
    if (this.eventTask) {
      return;
    }

    if (!this.link.isConnected()) {
      await this.link.connect();
    }

    try {
      await this.link.subscribeAgentRooms();
    } catch {
      // Best-effort — rooms can still be subscribed on demand.
    }
    if (this.autoSubscribeExistingRooms) {
      await this.subscribeExistingRooms();
    }

    if (this.link.capabilities.contacts) {
      await this.link.subscribeAgentContacts();
      this.contactsSubscribed = true;
    }

    this.eventController = new AbortController();
    this.eventTask = this.consumeEvents(this.eventController.signal);

    if (this.recoverySweepIntervalMs && this.recoverySweepIntervalMs > 0) {
      this.recoveryTimer = setInterval(() => {
        void this.runRecoverySweep();
      }, this.recoverySweepIntervalMs);
    }
  }

  public async stop(): Promise<void> {
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }

    this.eventController?.abort();
    await this.eventTask;
    this.eventTask = null;
    this.eventController = null;

    if (this.contactsSubscribed) {
      await this.link.unsubscribeAgentContacts();
      this.contactsSubscribed = false;
    }

    for (const roomId of [...this.rooms]) {
      await trackRoomLeave({
        link: this.link,
        roomId,
        trackedRooms: this.rooms,
        onLeft: this.onRoomLeft ?? undefined,
      });
    }
  }

  private async consumeEvents(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const event = await this.link.nextEvent(signal);
      if (!event) {
        return;
      }

      this.scheduleEvent(event);
    }
  }

  private scheduleEvent(event: PlatformEvent): void {
    this.scheduleRoomTask(
      event.roomId ?? "__global__",
      { eventType: event.type, roomId: event.roomId },
      () => this.handleEvent(event),
    );
  }

  private scheduleRoomTask(
    roomKey: string,
    context: { eventType: string; roomId: string | null },
    run: () => Promise<void>,
  ): void {
    const previous = this.roomTasks.get(roomKey) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(run)
      .catch((error) => {
        this.logger.warn("RoomPresence dropped event after handler failure", {
          ...context,
          error,
        });
      })
      .finally(() => {
        this.activeTasks.delete(task);
        if (this.roomTasks.get(roomKey) === task) {
          this.roomTasks.delete(roomKey);
        }
      });

    this.roomTasks.set(roomKey, task);
    this.activeTasks.add(task);
  }

  private async handleEvent(event: PlatformEvent): Promise<void> {
    switch (event.type) {
      case "room_added":
        await this.handleRoomAdded(event.roomId, event.payload as MetadataMap);
        break;
      case "room_removed":
      case "room_deleted":
        await this.handleRoomRemoved(event.roomId);
        break;
      case "contact_request_received":
      case "contact_request_updated":
      case "contact_added":
      case "contact_removed":
        await this.onContactEvent?.(event);
        break;
      default:
        if (event.roomId && this.rooms.has(event.roomId)) {
          await this.onRoomEvent?.(event.roomId, event);
        }
        break;
    }
  }

  private async handleRoomAdded(roomId: string | null, payload: MetadataMap): Promise<void> {
    await trackRoomJoin({
      link: this.link,
      roomId,
      payload,
      trackedRooms: this.rooms,
      roomFilter: this.roomFilter,
      onJoined: this.onRoomJoined ? this.enqueueRoomJoinedHandler() : undefined,
    });
  }

  private async handleRoomRemoved(roomId: string | null): Promise<void> {
    await trackRoomLeave({
      link: this.link,
      roomId,
      trackedRooms: this.rooms,
      onLeft: this.onRoomLeft ? this.enqueueRoomLeftHandler() : undefined,
    });
  }

  private enqueueRoomJoinedHandler(): RoomPresenceJoinHandler {
    return async (roomId, payload) => {
      this.scheduleRoomTask(
        roomId,
        { eventType: "room_joined", roomId },
        async () => this.onRoomJoined?.(roomId, payload),
      );
    };
  }

  private enqueueRoomLeftHandler(): RoomPresenceLeaveHandler {
    return async (roomId) => {
      this.scheduleRoomTask(
        roomId,
        { eventType: "room_left", roomId },
        async () => this.onRoomLeft?.(roomId),
      );
    };
  }

  private async subscribeExistingRooms(): Promise<void> {
    await hydrateTrackedRooms({
      link: this.link,
      trackedRooms: this.rooms,
      requestOptions: DEFAULT_REQUEST_OPTIONS,
      roomFilter: this.roomFilter,
      onJoined: this.onRoomJoined ? this.enqueueRoomJoinedHandler() : undefined,
      onLeft: this.onRoomLeft ? this.enqueueRoomLeftHandler() : undefined,
      pruneMissing: true,
      onError: async (error) => {
        this.logger.warn("RoomPresence failed to subscribe existing rooms", {
          error,
        });
      },
    });
  }

  private async runRecoverySweep(): Promise<void> {
    if (this.recoverySweepInFlight) {
      return;
    }

    this.recoverySweepInFlight = true;
    try {
      await this.subscribeExistingRooms();
    } finally {
      this.recoverySweepInFlight = false;
    }
  }
}
