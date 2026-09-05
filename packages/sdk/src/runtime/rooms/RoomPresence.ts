import type { MetadataMap } from "../../contracts/dtos";
import { DEFAULT_REQUEST_OPTIONS } from "../../client/rest/requestOptions";
import { RuntimeStateError } from "../../core/errors";
import type { BandLink } from "../../platform/BandLink";
import type {
  ContactEvent,
  MessageEvent,
  ParticipantAddedEvent,
  ParticipantRemovedEvent,
} from "../../platform/events";
import type { Logger } from "../../core/logger";
import { NoopLogger } from "../../core/logger";
import { RoomRoster } from "@band-ai/band-sdk-core";
import { hydrateExistingRooms } from "./subscriptions";

interface RoomPresenceOptions {
  link: BandLink;
  roomFilter?: (room: MetadataMap) => boolean;
  autoSubscribeExistingRooms?: boolean;
  logger?: Logger;
}

type RoomPresenceJoinHandler = (roomId: string, payload: MetadataMap) => Promise<void>;
type RoomPresenceLeaveHandler = (roomId: string) => Promise<void>;
type RoomPresenceEventHandler = (
  roomId: string,
  event: MessageEvent | ParticipantAddedEvent | ParticipantRemovedEvent,
) => Promise<void>;
type RoomPresenceContactHandler = (event: ContactEvent) => Promise<void>;

export class RoomPresence implements AsyncDisposable {
  public readonly roster = new RoomRoster();
  public onRoomJoined: RoomPresenceJoinHandler | null = null;
  public onRoomLeft: RoomPresenceLeaveHandler | null = null;
  public onRoomEvent: RoomPresenceEventHandler | null = null;
  public onContactEvent: RoomPresenceContactHandler | null = null;

  private readonly link: BandLink;
  private readonly roomFilter?: RoomPresenceOptions["roomFilter"];
  private readonly autoSubscribeExistingRooms: boolean;
  private readonly logger: Logger;
  private eventController: AbortController | null = null;
  private eventTask: Promise<void> | null = null;
  private contactsSubscribed = false;
  private lifecycle: Promise<void> = Promise.resolve();
  private readonly admissionInFlight = new Map<string, Promise<boolean>>();

  public constructor(options: RoomPresenceOptions) {
    this.link = options.link;
    this.roomFilter = options.roomFilter;
    this.autoSubscribeExistingRooms = options.autoSubscribeExistingRooms ?? true;
    this.logger = options.logger ?? new NoopLogger();
  }

  public async start(): Promise<void> {
    return this.serialize(() => this.startBody());
  }

  public async stop(): Promise<void> {
    return this.serialize(() => this.stopBody());
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.stop();
  }

  public abortEventLoop(): void {
    this.eventController?.abort();
  }

  public async waitUntilStopped(): Promise<void> {
    await this.eventTask;
  }

  public async admitRoom(roomId: string, payload: MetadataMap, notify = true): Promise<boolean> {
    const ticket = this.roster.beginRoomAdmission(roomId, true);
    if (ticket === undefined) {
      // Someone else already holds the ticket: report their real outcome
      // instead of a hardcoded false, so every racing caller learns the
      // truth rather than only the winner.
      const inFlight = this.admissionInFlight.get(roomId);
      return inFlight ? await inFlight : this.roster.roomMembership(roomId) === "admitted";
    }

    const admission = this.completeAdmission(roomId, ticket, payload, notify);
    this.admissionInFlight.set(roomId, admission);
    try {
      return await admission;
    } finally {
      if (this.admissionInFlight.get(roomId) === admission) {
        this.admissionInFlight.delete(roomId);
      }
    }
  }

  private async completeAdmission(
    roomId: string,
    ticket: bigint,
    payload: MetadataMap,
    notify: boolean,
  ): Promise<boolean> {
    let succeeded = false;
    let admitted = false;
    try {
      await this.link.subscribeRoom(roomId);
      succeeded = true;
    } catch (error) {
      this.logger.warn("RoomPresence failed to subscribe room", { roomId, error });
    } finally {
      admitted = this.roster.recordRoomAdmission(roomId, ticket, succeeded);
    }

    if (succeeded && !admitted) {
      this.logger.debug("RoomPresence admission ticket went stale", { roomId });
      await this.unsubscribeRoom(roomId);
    }

    if (!admitted) {
      return false;
    }

    if (notify) {
      await this.onRoomJoined?.(roomId, payload);
    }
    return true;
  }

  private serialize(body: () => Promise<void>): Promise<void> {
    const run = this.lifecycle.then(body, body);
    this.lifecycle = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async startBody(): Promise<void> {
    if (this.eventTask) {
      throw new RuntimeStateError("RoomPresence is already started");
    }

    if (!this.link.isConnected()) {
      await this.link.connect();
    }

    // Independent of the rooms channel/REST hydration below (no shared
    // state), so it runs concurrently instead of adding its latency to the
    // room-hydration critical path.
    const contactsReady = this.subscribeContacts();

    try {
      await this.link.subscribeAgentRooms();
    } catch (error) {
      this.logger.warn("RoomPresence failed to subscribe agent_rooms channel, continuing without it", {
        error,
      });
    }

    if (this.autoSubscribeExistingRooms) {
      await this.subscribeExistingRooms();
    }

    await contactsReady;

    this.eventController = new AbortController();
    this.eventTask = this.consumeEvents(this.eventController.signal);
  }

  private async subscribeContacts(): Promise<void> {
    if (!this.link.capabilities.contacts) {
      return;
    }

    try {
      await this.link.subscribeAgentContacts();
      this.contactsSubscribed = true;
    } catch (error) {
      this.logger.warn("RoomPresence failed to subscribe agent_contacts channel, continuing without it", {
        error,
      });
    }
  }

  private async stopBody(): Promise<void> {
    this.abortEventLoop();
    await this.eventTask?.catch(() => undefined);
    this.eventTask = null;
    this.eventController = null;

    if (this.contactsSubscribed) {
      try {
        await this.link.unsubscribeAgentContacts();
      } catch (error) {
        this.logger.warn("RoomPresence failed to unsubscribe agent_contacts channel", { error });
      } finally {
        this.contactsSubscribed = false;
      }
    }

    const roomIds = this.roster.trackedRoomIds();
    this.roster.clear();
    // Each room's unsubscribe + onRoomLeft only touches that room's own
    // transport topic and (via AgentRuntime's handler) its own map entries,
    // so nothing here races across rooms.
    await Promise.all(
      roomIds.map(async (roomId) => {
        await this.unsubscribeRoom(roomId);
        await this.onRoomLeft?.(roomId);
      }),
    );
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
        case "message_created":
        case "participant_added":
        case "participant_removed":
          if (event.roomId && this.roster.roomMembership(event.roomId) === "admitted") {
            await this.onRoomEvent?.(event.roomId, event);
          }
          break;
        default:
          assertNever(event);
      }
    }
  }

  private async handleRoomAdded(roomId: string | null, payload: MetadataMap): Promise<void> {
    if (!roomId) {
      return;
    }
    if (this.roomFilter && !this.roomFilter(payload)) {
      return;
    }
    await this.admitRoom(roomId, payload);
  }

  private async handleRoomRemoved(roomId: string | null): Promise<void> {
    if (!roomId) {
      return;
    }

    await this.unsubscribeRoom(roomId);
    if (!this.roster.recordRoomRemoved(roomId)) {
      this.logger.debug("RoomPresence ignoring removal for untracked room", { roomId });
      return;
    }
    await this.onRoomLeft?.(roomId);
  }

  private async unsubscribeRoom(roomId: string): Promise<void> {
    try {
      await this.link.unsubscribeRoom(roomId);
    } catch (error) {
      this.logger.warn("RoomPresence failed to unsubscribe room", { roomId, error });
    }
  }

  private async subscribeExistingRooms(): Promise<void> {
    await hydrateExistingRooms({
      link: this.link,
      roomFilter: this.roomFilter,
      requestOptions: DEFAULT_REQUEST_OPTIONS,
      onRoom: async (roomId, payload) => {
        await this.admitRoom(roomId, payload);
      },
      onError: (error) => {
        this.logger.warn("RoomPresence failed to subscribe existing rooms", { error });
      },
    });
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled platform event: ${JSON.stringify(value)}`);
}
