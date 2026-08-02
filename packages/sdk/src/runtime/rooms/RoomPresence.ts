import type { MetadataMap } from "../../contracts/dtos";
import { DEFAULT_REQUEST_OPTIONS } from "../../client/rest/requestOptions";
import type { BandLink } from "../../platform/BandLink";
import type { ContactEvent, PlatformEvent } from "../../platform/events";
import type { Logger } from "../../core/logger";
import { NoopLogger } from "../../core/logger";
import { hydrateTrackedRooms, trackRoomJoin, trackRoomLeave } from "./subscriptions";

interface RoomPresenceOptions {
  link: BandLink;
  roomFilter?: (room: MetadataMap) => boolean;
  autoSubscribeExistingRooms?: boolean;
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

  private readonly link: BandLink;
  private readonly roomFilter?: (room: MetadataMap) => boolean;
  private readonly autoSubscribeExistingRooms: boolean;
  private readonly logger: Logger;
  private eventController: AbortController | null = null;
  private eventTask: Promise<void> | null = null;
  private contactsSubscribed = false;

  public constructor(options: RoomPresenceOptions) {
    this.link = options.link;
    this.roomFilter = options.roomFilter;
    this.autoSubscribeExistingRooms = options.autoSubscribeExistingRooms ?? true;
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
  }

  public async stop(): Promise<void> {
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
  }

  private async handleRoomAdded(roomId: string | null, payload: MetadataMap): Promise<void> {
    await trackRoomJoin({
      link: this.link,
      roomId,
      payload,
      trackedRooms: this.rooms,
      roomFilter: this.roomFilter,
      onJoined: this.onRoomJoined ?? undefined,
    });
  }

  private async handleRoomRemoved(roomId: string | null): Promise<void> {
    await trackRoomLeave({
      link: this.link,
      roomId,
      trackedRooms: this.rooms,
      onLeft: this.onRoomLeft ?? undefined,
    });
  }

  private async subscribeExistingRooms(): Promise<void> {
    await hydrateTrackedRooms({
      link: this.link,
      trackedRooms: this.rooms,
      requestOptions: DEFAULT_REQUEST_OPTIONS,
      roomFilter: this.roomFilter,
      onJoined: this.onRoomJoined ?? undefined,
      onError: async (error) => {
        this.logger.warn("RoomPresence failed to subscribe existing rooms", {
          error,
        });
      },
    });
  }
}
